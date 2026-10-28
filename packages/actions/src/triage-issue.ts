import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ExitCode,
  type RunResult,
  type TriageConfig,
  type TriageDecision,
} from "@agentic-action/contracts";
import {
  buildIssueState,
  buildIssueTypeQuestion,
  collectSensitiveValues,
  hasAnyConfiguredTypeLabel,
  parseAndValidateTriageConfig,
  verifyClassification,
} from "@agentic-action/core";
import {
  applyTriageLabelIdempotent,
  callSystemOne,
  createLogger,
  getIssueDetails,
  writeGitHubOutput,
  writeRunResult,
  writeStepSummary,
} from "@agentic-action/adapters";

export interface TriageIssueOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

export interface TriageResultDetails {
  issueNumber?: number;
  model?: string;
  confidenceFloor: number;
  decision?: TriageDecision;
  label?: string;
  type?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
  applied?: boolean;
  executorAction?: "applied" | "skipped_existing" | "dry_run";
}

function loadTriageConfigContent(
  configInput: string | undefined,
  cwd: string,
): string | undefined {
  const raw = (configInput ?? ".github/triage.yml").trim();
  if (!raw) return undefined;
  if (raw.includes("\n")) return raw;

  const fullPath = resolve(cwd, raw);
  if (existsSync(fullPath)) {
    return readFileSync(fullPath, "utf8");
  }
  if (raw === ".github/triage.yml") {
    return undefined;
  }
  throw new Error(`指定的 triage 配置文件不存在: ${raw}`);
}

function readIssueFromEventPath(eventPath?: string): {
  number?: number;
  title?: string;
  body?: string;
  labels?: string[];
} {
  if (!eventPath || !existsSync(eventPath)) return {};
  try {
    const ev = JSON.parse(readFileSync(eventPath, "utf8")) as {
      issue?: {
        number?: number;
        title?: string;
        body?: string | null;
        labels?: Array<string | { name?: string }>;
      };
    };
    const issue = ev.issue;
    if (!issue) return {};
    const labels = (issue.labels ?? [])
      .map((l) => (typeof l === "string" ? l : (l?.name ?? "")))
      .filter(Boolean);
    return {
      number: issue.number,
      title: issue.title ?? "",
      body: issue.body ?? "",
      labels,
    };
  } catch {
    return {};
  }
}

export async function runIssueTriage(
  env: NodeJS.ProcessEnv = process.env,
  options: TriageIssueOptions = {},
): Promise<{
  exitCode: ExitCode;
  result: RunResult<TriageResultDetails>;
  resultFile: string;
}> {
  const startMs = Date.now();
  const cwd = options.cwd ?? process.cwd();
  const fetchImpl = options.fetchImpl ?? fetch;

  const typesafeApiKey = (
    env.INPUT_TYPESAFE_API_KEY ||
    env.TYPESAFE_API_KEY ||
    ""
  ).trim();
  const typesafeBaseUrl = (
    env.INPUT_TYPESAFE_BASE_URL ||
    env.TYPESAFE_BASE_URL ||
    "https://api.typesafe.ai"
  ).trim();
  const githubToken = (
    env.INPUT_GITHUB_TOKEN ||
    env.GH_TOKEN ||
    env.GITHUB_TOKEN ||
    ""
  ).trim();
  const repo = (env.INPUT_REPOSITORY || env.GITHUB_REPOSITORY || "").trim();
  const applyLabel = (env.INPUT_APPLY_LABEL ?? "true").trim() !== "false";
  const writeSummary = (env.INPUT_WRITE_SUMMARY ?? "true").trim() !== "false";
  const apiUrl = (env.GITHUB_API_URL || "https://api.github.com").replace(
    /\/+$/,
    "",
  );

  const secretValues = collectSensitiveValues(env, [
    typesafeApiKey,
    githubToken,
  ]);
  const logger = createLogger("triage", secretValues);

  const tempBase = env.RUNNER_TEMP || tmpdir();
  const artifactDir = env.INPUT_ARTIFACT_DIR
    ? resolve(cwd, env.INPUT_ARTIFACT_DIR)
    : join(tempBase, "pi-triage-result");
  mkdirSync(artifactDir, { recursive: true });

  const failInfra = (reason: string) => {
    logger.error(reason);
    const envelope: RunResult<TriageResultDetails> = {
      schemaVersion: 2,
      status: "infrastructure_error",
      exitCode: ExitCode.Infrastructure,
      verdict: "error",
      timings: { totalMs: Date.now() - startMs },
      error: reason,
    };
    const resultFile = writeRunResult(artifactDir, envelope, secretValues);
    writeGitHubOutput(
      {
        type: "",
        label: "",
        confidence: "",
        verdict: "error",
        applied: "false",
        result_file: resultFile,
        exit_code: String(ExitCode.Infrastructure),
      },
      env.GITHUB_OUTPUT,
      secretValues,
    );
    return {
      exitCode: ExitCode.Infrastructure,
      result: envelope,
      resultFile,
    };
  };

  // 1. Load & validate triage config
  let config: TriageConfig;
  try {
    const rawConfig = loadTriageConfigContent(env.INPUT_TRIAGE_CONFIG, cwd);
    config = parseAndValidateTriageConfig(rawConfig);
  } catch (err) {
    return failInfra(err instanceof Error ? err.message : String(err));
  }

  // 2. Resolve issue metadata
  const eventIssue = readIssueFromEventPath(env.GITHUB_EVENT_PATH);
  const issueNumRaw = (env.INPUT_ISSUE_NUMBER || "").trim();
  const issueNumber = issueNumRaw ? Number(issueNumRaw) : eventIssue.number;

  let title = env.INPUT_ISSUE_TITLE ?? eventIssue.title ?? "";
  let body = env.INPUT_ISSUE_BODY ?? eventIssue.body ?? "";
  let existingLabels: string[] | undefined = env.INPUT_ISSUE_LABELS
    ? env.INPUT_ISSUE_LABELS.split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : eventIssue.labels;

  if (
    (!title && !body && issueNumber && repo && githubToken) ||
    (existingLabels === undefined && applyLabel && issueNumber && repo && githubToken)
  ) {
    try {
      const fetched = await getIssueDetails({
        repo,
        issueNumber,
        token: githubToken,
        apiUrl,
        fetchImpl,
      });
      if (!title) title = fetched.title;
      if (!body) body = fetched.body;
      if (existingLabels === undefined) existingLabels = fetched.labels;
    } catch (err) {
      return failInfra(
        `读取 Issue #${issueNumber} 详情失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 3. Idempotent early check: if issue already has a configured type label, skip immediately
  if (
    existingLabels &&
    hasAnyConfiguredTypeLabel(existingLabels, config)
  ) {
    logger.info("Issue 已存在配置的类型标签，跳过自动分类", {
      issueNumber,
      existingLabels,
    });
    const envelope: RunResult<TriageResultDetails> = {
      schemaVersion: 2,
      status: "skipped",
      exitCode: ExitCode.Ok,
      verdict: "skipped_existing",
      timings: { totalMs: Date.now() - startMs },
      details: {
        issueNumber,
        confidenceFloor: config.confidence_floor,
        applied: false,
        executorAction: "skipped_existing",
      },
    };
    const resultFile = writeRunResult(artifactDir, envelope, secretValues);
    writeGitHubOutput(
      {
        type: "",
        label: "",
        confidence: "",
        verdict: "skipped_existing",
        applied: "false",
        result_file: resultFile,
        exit_code: String(ExitCode.Ok),
      },
      env.GITHUB_OUTPUT,
      secretValues,
    );
    return { exitCode: ExitCode.Ok, result: envelope, resultFile };
  }

  // 4. Call TypeSafe Jev
  const state = buildIssueState({ title, body }, config.max_body_chars);
  const question = buildIssueTypeQuestion(config);
  const policyStart = Date.now();

  let jevResponse: unknown;
  try {
    jevResponse = await callSystemOne(
      {
        model: config.model,
        state,
        questions: { type: question },
      },
      {
        apiKey: typesafeApiKey,
        baseUrl: typesafeBaseUrl,
        fetchImpl,
        sleepImpl: options.sleepImpl,
      },
    );
  } catch (err) {
    return failInfra(err instanceof Error ? err.message : String(err));
  }
  const policyMs = Date.now() - policyStart;

  // 5. Run pure Verifier
  const decision = verifyClassification(config, jevResponse, "type");

  if (decision.kind === "invalid") {
    logger.error(`Verifier 判定响应非法: ${decision.reason}`);
    const envelope: RunResult<TriageResultDetails> = {
      schemaVersion: 2,
      status: "invalid_report",
      exitCode: ExitCode.InvalidReport,
      verdict: "invalid",
      timings: { policyMs, totalMs: Date.now() - startMs },
      details: {
        issueNumber,
        confidenceFloor: config.confidence_floor,
        decision,
        applied: false,
      },
      error: decision.reason,
    };
    const resultFile = writeRunResult(artifactDir, envelope, secretValues);
    writeGitHubOutput(
      {
        type: "",
        label: "",
        confidence: "",
        verdict: "invalid",
        applied: "false",
        result_file: resultFile,
        exit_code: String(ExitCode.InvalidReport),
      },
      env.GITHUB_OUTPUT,
      secretValues,
    );
    return {
      exitCode: ExitCode.InvalidReport,
      result: envelope,
      resultFile,
    };
  }

  // 6. Run Executor (idempotent label application)
  let publishMs = 0;
  let executorAction: "applied" | "skipped_existing" | "dry_run" = "dry_run";

  if (applyLabel && repo && issueNumber && githubToken) {
    const pubStart = Date.now();
    try {
      const execRes = await applyTriageLabelIdempotent({
        repo,
        issueNumber,
        targetLabel: decision.label,
        config,
        existingIssueLabels: existingLabels,
        token: githubToken,
        apiUrl,
        fetchImpl,
      });
      executorAction = execRes.action;
    } catch (err) {
      return failInfra(err instanceof Error ? err.message : String(err));
    }
    publishMs = Date.now() - pubStart;
  }

  const resolvedType =
    decision.kind === "accepted" ? decision.type : decision.top;
  const verdict =
    decision.kind === "accepted" ? "accepted" : "degraded";
  const status = decision.kind === "accepted" ? "ok" : "degraded";

  const envelope: RunResult<TriageResultDetails> = {
    schemaVersion: 2,
    status,
    exitCode: ExitCode.Ok,
    verdict,
    timings: {
      policyMs,
      ...(publishMs > 0 ? { publishMs } : {}),
      totalMs: Date.now() - startMs,
    },
    details: {
      issueNumber,
      model: decision.model,
      confidenceFloor: config.confidence_floor,
      decision,
      label: decision.label,
      type: resolvedType,
      confidence: decision.confidence,
      probabilities: decision.probabilities,
      applied: executorAction === "applied",
      executorAction,
    },
  };

  const resultFile = writeRunResult(artifactDir, envelope, secretValues);

  writeGitHubOutput(
    {
      type: decision.kind === "accepted" ? decision.type : config.fallback,
      label: decision.label,
      confidence: String(decision.confidence),
      verdict,
      applied: String(executorAction === "applied"),
      result_file: resultFile,
      exit_code: String(ExitCode.Ok),
    },
    env.GITHUB_OUTPUT,
    secretValues,
  );

  if (writeSummary) {
    const summaryLines = [
      `- **判定结果**: \`${verdict}\`${decision.kind === "degraded" ? ` (${decision.reason})` : ""}`,
      `- **类型**: \`${resolvedType}\` -> 标签 \`${decision.label}\``,
      `- **置信度**: \`${decision.confidence.toFixed(4)}\`（阈值 \`${config.confidence_floor}\`）`,
      `- **模型**: \`${decision.model}\``,
      `- **标签写入**: \`${executorAction}\``,
    ];
    writeStepSummary(
      summaryLines.join("\n"),
      "text",
      env.GITHUB_STEP_SUMMARY,
      secretValues,
      "## Issue Triage (Jev)",
    );
  }

  return {
    exitCode: ExitCode.Ok,
    result: envelope,
    resultFile,
  };
}

if (
  process.argv[1] &&
  import.meta.url === `file://${resolve(process.argv[1])}`
) {
  runIssueTriage(process.env)
    .then(({ exitCode }) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stderr.write(
        `[triage] 错误: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = ExitCode.Infrastructure;
    });
}
