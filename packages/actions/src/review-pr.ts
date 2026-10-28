import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ExitCode,
  type ReviewPlan,
  type ReviewReport,
  type RunResult,
  type ThinkingLevel,
} from "@agentic-action/contracts";
import {
  collectSensitiveValues,
  decideGate,
  hasModelCredentials,
  mergeChunkReports,
  parseFailOn,
  planChunks,
  redactText,
} from "@agentic-action/core";
import {
  collectDiffInventory,
  collectSnapshotInventory,
  createLogger,
  materializeReviewContext,
  renderReviewComment,
  resolveBaseSha,
  scrubGitCredentials,
  upsertMarkerComment,
  writeGitHubOutput,
  writeRunResult,
  writeStepSummary,
  type GitHubIssueData,
} from "@agentic-action/adapters";
import { resolveIssuePrLinkage } from "./review-pr-linkage.ts";
import { executeReviewChunks } from "./review-pr-runner.ts";

export { buildReviewPrompt } from "./review-pr-linkage.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
function resolveDefaultActionRoot(): string {
  const distParent = resolve(__dirname, "..");
  if (existsSync(join(distParent, "packages/extensions/src"))) {
    return distParent;
  }
  return resolve(__dirname, "../../..");
}
const REPO_ROOT = resolveDefaultActionRoot();

function readPrMetadataFromEvent(eventPath?: string): {
  prNumber?: string;
  title?: string;
  body?: string;
  baseSha?: string;
} {
  if (!eventPath || !existsSync(eventPath)) return {};
  try {
    const ev = JSON.parse(readFileSync(eventPath, "utf8")) as {
      pull_request?: {
        number?: number;
        title?: string;
        body?: string | null;
        base?: { sha?: string };
      };
    };
    const pr = ev.pull_request;
    if (!pr) return {};
    return {
      prNumber: pr.number ? String(pr.number) : undefined,
      title: pr.title ?? "",
      body: pr.body ?? "",
      baseSha: pr.base?.sha ?? undefined,
    };
  } catch {
    return {};
  }
}

export interface RunPrReviewOptions {
  cwd?: string;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

export async function runPrReview(
  env: NodeJS.ProcessEnv = process.env,
  options: RunPrReviewOptions = {},
): Promise<ExitCode> {
  const startMs = Date.now();
  const cwd = options.cwd ?? process.cwd();
  const fetchImpl = options.fetchImpl ?? fetch;
  const actionRoot = env.ACTION_ROOT ? resolve(cwd, env.ACTION_ROOT) : REPO_ROOT;

  const eventPr = readPrMetadataFromEvent(env.GITHUB_EVENT_PATH);
  const prNumber = (env.INPUT_PR_NUMBER || eventPr.prNumber || "").trim();
  const maxChunks = Math.max(0, Number(env.INPUT_MAX_CHUNKS || "0") || 0);
  const maxChunkLines = Math.max(1, Number(env.INPUT_MAX_CHUNK_LINES || "1500") || 1500);
  const maxChunkBytes = Math.max(1, Number(env.INPUT_MAX_CHUNK_BYTES || "40960") || 40960);
  const maxFileBytes = Math.max(1, Number(env.INPUT_MAX_FILE_BYTES || "409600") || 409600);
  const maxFiles = Math.max(0, Number(env.INPUT_MAX_FILES || "0") || 0);
  const maxSnapshotBytes = 50 * 1024 * 1024;
  const concurrency = Math.max(1, Math.min(8, Number(env.INPUT_CONCURRENCY || "2") || 2));
  const allowPartial = (env.INPUT_ALLOW_PARTIAL || "false").trim() === "true";
  const postComment = (env.INPUT_POST_COMMENT || "true").trim() === "true";
  const marker = (env.INPUT_COMMENT_MARKER || "pi-review").trim();
  const reportTitle = (env.INPUT_REPORT_TITLE || "Pi Agent 代码审查").trim();
  const auditModeRaw = (env.INPUT_AUDIT_MODE || "diff").trim().toLowerCase();
  const targetPath = (env.INPUT_TARGET_PATH || ".").trim() || ".";
  const extraExclude = (env.INPUT_EXCLUDE || "")
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const extraInclude = (env.INPUT_INCLUDE || "")
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const resolvedTargetAbs = resolve(cwd, targetPath);
  const relTarget = relative(cwd, resolvedTargetAbs).split("\\").join("/");
  const diffIncludes = [...extraInclude];
  if (
    relTarget &&
    relTarget !== "." &&
    !relTarget.startsWith("..") &&
    diffIncludes.length === 0
  ) {
    diffIncludes.push(relTarget, `${relTarget}/**`);
  }

  const linkIssues = (env.INPUT_LINK_ISSUES ?? "true").trim() !== "false";
  const includeIssueBody = (env.INPUT_INCLUDE_ISSUE_BODY ?? "false").trim() === "true";
  const typesafeApiKey = (env.INPUT_TYPESAFE_API_KEY || env.TYPESAFE_API_KEY || "").trim();
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
  const repo = (env.GITHUB_REPOSITORY || "").trim();
  const apiUrl = (env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");

  const secretValues = collectSensitiveValues(env, [
    env.INPUT_API_KEY,
    githubToken,
    typesafeApiKey,
  ]);
  const logger = createLogger("pr-review", secretValues);

  const tempBase = env.RUNNER_TEMP || tmpdir();
  const contextDir = env.INPUT_CONTEXT_DIR
    ? resolve(cwd, env.INPUT_CONTEXT_DIR)
    : join(tempBase, "pi-review-context");
  mkdirSync(contextDir, { recursive: true });

  const failInfra = (reason: string): ExitCode => {
    logger.error(reason);
    const envelope: RunResult = {
      schemaVersion: 2,
      status: "infrastructure_error",
      exitCode: ExitCode.Infrastructure,
      verdict: "error",
      timings: { totalMs: Date.now() - startMs },
      error: reason,
    };
    writeRunResult(contextDir, envelope, secretValues);
    writeGitHubOutput(
      {
        context_dir: contextDir,
        report_file: "",
        comment_file: "",
        result: "",
        result_file: "",
        verdict: "error",
        findings_count: "0",
        exit_code: String(ExitCode.Infrastructure),
      },
      env.GITHUB_OUTPUT,
      secretValues,
    );
    return ExitCode.Infrastructure;
  };

  let failOn;
  try {
    failOn = parseFailOn(env.INPUT_FAIL_ON || "high");
  } catch (err) {
    return failInfra(err instanceof Error ? err.message : String(err));
  }

  scrubGitCredentials(cwd);

  const hasDiffAnchor = Boolean(
    (env.INPUT_BASE_SHA || eventPr.baseSha || prNumber || "").trim(),
  );
  const useSnapshotMode =
    auditModeRaw === "codebase" || (auditModeRaw === "auto" && !hasDiffAnchor);

  let baseSha = "SNAPSHOT";
  let resolveBaseMs = 0;
  let inventory;
  const diffStart = Date.now();

  if (useSnapshotMode) {
    try {
      inventory = collectSnapshotInventory({
        cwd,
        outDir: contextDir,
        targetPath,
        maxFileBytes,
        maxFiles,
        maxSnapshotBytes,
        excludes: extraExclude,
        includes: extraInclude,
      });
    } catch (err) {
      return failInfra(err instanceof Error ? err.message : String(err));
    }
  } else {
    const resolveStart = Date.now();
    try {
      baseSha = resolveBaseSha({
        baseSha: env.INPUT_BASE_SHA || eventPr.baseSha,
        prNumber,
        cwd,
        env,
        githubToken,
      });
    } catch (err) {
      return failInfra(err instanceof Error ? err.message : String(err));
    }
    resolveBaseMs = Date.now() - resolveStart;

    try {
      inventory = collectDiffInventory({
        cwd,
        outDir: contextDir,
        base: baseSha,
        maxFileBytes,
        maxFiles,
        maxSnapshotBytes,
        excludes: extraExclude,
        includes: diffIncludes,
        baseSnapshot: true,
      });
      if (
        auditModeRaw === "auto" &&
        targetPath !== "." &&
        targetPath !== "./" &&
        inventory.files.length === 0 &&
        existsSync(resolve(cwd, targetPath))
      ) {
        inventory = collectSnapshotInventory({
          cwd,
          outDir: contextDir,
          targetPath,
          maxFileBytes,
          maxFiles,
          maxSnapshotBytes,
          excludes: extraExclude,
          includes: extraInclude,
        });
      }
    } catch (err) {
      return failInfra(err instanceof Error ? err.message : String(err));
    }
  }
  const diffMs = Date.now() - diffStart;

  const chunkPlan = planChunks(inventory, { maxChunks, maxChunkLines, maxChunkBytes });

  const credsAvailable = hasModelCredentials(
    { apiKey: env.INPUT_API_KEY, provider: env.INPUT_PROVIDER, model: env.INPUT_MODEL },
    env,
  );

  if (!credsAvailable) {
    materializeReviewContext({
      outDir: contextDir,
      inventory,
      plan: chunkPlan,
      maxChunkLines,
      maxChunkBytes,
      maxFileBytes,
      maxFiles,
      maxSnapshotBytes,
    });
    logger.info("未检测到模型 API Key（可能是 fork PR 或未配置密钥），跳过模型审查与回评");
    writeRunResult(
      contextDir,
      {
        schemaVersion: 2,
        status: "skipped",
        exitCode: ExitCode.Ok,
        verdict: "skipped",
        timings: { resolveBaseMs, diffMs, totalMs: Date.now() - startMs },
      },
      secretValues,
    );
    writeGitHubOutput(
      {
        context_dir: contextDir,
        report_file: "",
        comment_file: "",
        result: "",
        result_file: "",
        verdict: "skipped",
        findings_count: "0",
        exit_code: String(ExitCode.Ok),
      },
      env.GITHUB_OUTPUT,
      secretValues,
    );
    return ExitCode.Ok;
  }

  const policyStart = Date.now();
  const configuredThinking = (env.INPUT_THINKING || "high").trim() as ThinkingLevel;
  let reviewPlan: ReviewPlan = { focus: [], notes: [] };
  let linkedIssues: GitHubIssueData[] = [];

  if (linkIssues) {
    const linkage = await resolveIssuePrLinkage({
      cwd,
      repo,
      prNumber,
      prTitle: env.INPUT_PR_TITLE ?? eventPr.title ?? "",
      prBody: env.INPUT_PR_BODY ?? eventPr.body ?? "",
      inventory,
      configuredThinking,
      triageConfigInput: env.INPUT_TRIAGE_CONFIG,
      explicitLinkIssues: env.INPUT_LINK_ISSUES === "true",
      typesafeApiKey,
      typesafeBaseUrl,
      githubToken,
      apiUrl,
      fetchImpl,
      sleepImpl: options.sleepImpl,
    });
    reviewPlan = linkage.reviewPlan;
    linkedIssues = linkage.linkedIssues;
  }
  const policyMs = Date.now() - policyStart;

  materializeReviewContext({
    outDir: contextDir,
    inventory,
    plan: chunkPlan,
    maxChunkLines,
    maxChunkBytes,
    maxFileBytes,
    maxFiles,
    maxSnapshotBytes,
    linkedIssues,
    includeIssueBody,
  });

  const reportFile = join(contextDir, "report.json");
  const commentFile = join(contextDir, "review-comment.md");
  const rawResultFile = join(contextDir, "pi-raw-output.txt");

  const { chunkReports, agentDurations, mergedUsage } =
    chunkPlan.plannedChunks === 0
      ? { chunkReports: [], agentDurations: [], mergedUsage: undefined }
      : await executeReviewChunks({
          cwd,
          actionRoot,
          env,
          prNumber,
          contextDir,
          reportFile,
          rawResultFile,
          chunkPlan,
          reviewPlan,
          configuredThinking,
          concurrency,
          githubToken,
          secretValues,
          logger,
          sleepImpl: options.sleepImpl,
        });

  let finalReport: ReviewReport;
  let gateExitCode: ExitCode;
  let commentMarkdown: string;

  if (chunkPlan.plannedChunks > 0 && chunkReports.length === 0) {
    gateExitCode = ExitCode.InvalidReport;
    finalReport = {
      summary: "本次运行未能产出结构化审查结果（Agent 未调用 submit_review 且未返回有效报告）。",
      verdict: "error",
      coverage: {
        planned: 0,
        total: 0,
        chunks_reviewed: [],
        chunks_planned: chunkPlan.plannedChunks,
        chunks_total: chunkPlan.totalChunks,
        files_reviewed: 0,
        files_total: chunkPlan.filesIncluded.length,
      },
      findings: [],
      ...(reviewPlan.notes.length > 0 ? { policyNotes: reviewPlan.notes } : {}),
    };
    commentMarkdown = redactText(
      [
        `<!-- ${marker}:begin -->`,
        `## ${reportTitle}`,
        "",
        "本次运行未能产出结构化审查结果（Agent 未按契约返回有效报告）。",
        "请查看本次运行的日志与上传的 artifact。",
        `<!-- ${marker}:end -->`,
      ].join("\n"),
      secretValues,
    );
    writeFileSync(commentFile, `${commentMarkdown}\n`, "utf8");
  } else {
    finalReport = mergeChunkReports(chunkReports, chunkPlan, reviewPlan.notes);
    const gate = decideGate(finalReport, failOn, { allowPartial });
    gateExitCode = gate.exitCode;
    finalReport.verdict = gate.verdict;

    writeFileSync(
      reportFile,
      redactText(`${JSON.stringify(finalReport, null, 2)}\n`, secretValues),
      "utf8",
    );
    commentMarkdown = renderReviewComment(finalReport, {
      marker,
      title: reportTitle,
      secretValues,
    });
    writeFileSync(commentFile, `${commentMarkdown}\n`, "utf8");
  }

  writeStepSummary(
    commentMarkdown,
    "text",
    env.GITHUB_STEP_SUMMARY,
    secretValues,
    `## ${reportTitle}`,
  );

  let publishMs: number | undefined;
  if (postComment && prNumber && repo && githubToken && commentMarkdown) {
    const pubStart = Date.now();
    try {
      await upsertMarkerComment({
        repo,
        pr: prNumber,
        body: commentMarkdown,
        marker,
        token: githubToken,
        apiUrl,
        fetchImpl,
        sleepImpl: options.sleepImpl,
      });
    } catch (pubErr) {
      logger.warn(`发布 PR 评论失败: ${pubErr instanceof Error ? pubErr.message : String(pubErr)}`);
    }
    publishMs = Date.now() - pubStart;
  }

  const statusMap: Record<ExitCode, RunResult["status"]> = {
    [ExitCode.Ok]: "ok",
    [ExitCode.GateFailed]: "gate_failed",
    [ExitCode.InvalidReport]: "invalid_report",
    [ExitCode.Infrastructure]: "infrastructure_error",
  };

  const envelope: RunResult = {
    schemaVersion: 2,
    status: statusMap[gateExitCode] ?? "infrastructure_error",
    exitCode: gateExitCode,
    verdict: finalReport.verdict,
    coverage: {
      planned: finalReport.coverage.planned,
      total: finalReport.coverage.total,
      chunksReviewed: finalReport.coverage.chunks_reviewed,
      chunksPlanned: finalReport.coverage.chunks_planned,
      chunksTotal: finalReport.coverage.chunks_total,
      filesReviewed: finalReport.coverage.files_reviewed,
      filesTotal: finalReport.coverage.files_total,
    },
    findings: finalReport.findings,
    timings: {
      resolveBaseMs,
      diffMs,
      policyMs,
      agentMs: agentDurations,
      ...(publishMs !== undefined ? { publishMs } : {}),
      totalMs: Date.now() - startMs,
    },
    ...(mergedUsage ? { agentUsage: mergedUsage } : {}),
  };

  writeRunResult(contextDir, envelope, secretValues);

  writeGitHubOutput(
    {
      context_dir: contextDir,
      report_file: existsSync(reportFile) ? reportFile : "",
      comment_file: existsSync(commentFile) ? commentFile : "",
      result: commentMarkdown.trim(),
      result_file: existsSync(commentFile) ? commentFile : rawResultFile,
      verdict: finalReport.verdict,
      findings_count: String(finalReport.findings.length),
      planned_coverage: String(finalReport.coverage.planned),
      total_coverage: String(finalReport.coverage.total),
      exit_code: String(gateExitCode),
    },
    env.GITHUB_OUTPUT,
    secretValues,
  );

  if (gateExitCode === ExitCode.GateFailed) {
    const prefix = env.PI_SUPPRESS_GH_ANNOTATIONS === "1" ? "[pr-review] " : "::error::";
    process.stderr.write(`${prefix}审查发现达到或高于 ${failOn} 级别的问题，详见 PR 评论\n`);
  } else if (gateExitCode === ExitCode.InvalidReport) {
    const prefix = env.PI_SUPPRESS_GH_ANNOTATIONS === "1" ? "[pr-review] " : "::error::";
    process.stderr.write(`${prefix}审查未能产出有效结构化报告或未完成计划分块，请检查运行日志\n`);
  }

  return gateExitCode;
}

if (
  process.argv[1] &&
  import.meta.url === `file://${resolve(process.argv[1])}`
) {
  runPrReview(process.env)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(
        `[pr-review] 错误: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = ExitCode.Infrastructure;
    });
}
