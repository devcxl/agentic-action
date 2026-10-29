import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type {
  AgentSpec,
  AgentUsage,
  ChunkPlan,
  ChunkReport,
  DiffInventory,
  ReviewPlan,
  ThinkingLevel,
} from "@agentic-action/contracts";
import {
  buildSandboxSpec,
  deriveCapabilityPolicy,
  extractJsonReport,
  isPathEscaping,
  redactText,
  toChunkReport,
  validateSubmitReviewInput,
} from "@agentic-action/core";
import {
  createEmptyUsage,
  parseContextFiles,
  resolveTextOrFile,
  runPiWithRetry,
  writeChunkReport,
  type Logger,
} from "@agentic-action/adapters";
import {
  BUILTIN_REVIEW_SYSTEM_PROMPT,
  BUILTIN_SECURITY_AUDIT_SYSTEM_PROMPT,
  buildReviewPrompt,
} from "./review-pr-linkage.ts";

function resolveSubmitReviewExtensionPath(actionRoot: string): string | undefined {
  const candidates = [
    join(actionRoot, "packages/extensions/src/submit-review.ts"),
    ...(process.env.ACTION_PATH
      ? [join(process.env.ACTION_PATH, "packages/extensions/src/submit-review.ts")]
      : []),
  ];
  return candidates.find((c) => existsSync(c));
}

export function mergeAgentUsages(usages: readonly AgentUsage[]): AgentUsage {
  const merged = createEmptyUsage();
  for (const u of usages) {
    merged.inputTokens += u.inputTokens;
    merged.outputTokens += u.outputTokens;
    merged.cacheReadTokens += u.cacheReadTokens;
    merged.cacheWriteTokens += u.cacheWriteTokens;
    merged.reasoningTokens += u.reasoningTokens;
    merged.totalTokens += u.totalTokens;
    merged.costTotal = Number((merged.costTotal + u.costTotal).toFixed(6));
  }
  return merged;
}

export async function executeReviewChunks(params: {
  cwd: string;
  actionRoot: string;
  env: NodeJS.ProcessEnv;
  prNumber: string;
  contextDir: string;
  reportFile: string;
  rawResultFile: string;
  chunkPlan: ChunkPlan;
  reviewPlan: ReviewPlan;
  inventory?: DiffInventory;
  configuredThinking: ThinkingLevel;
  concurrency: number;
  githubToken: string;
  secretValues: readonly string[];
  logger: Logger;
  sleepImpl?: (ms: number) => Promise<void>;
}): Promise<{
  chunkReports: ChunkReport[];
  agentDurations: number[];
  mergedUsage: AgentUsage;
}> {
  const {
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
    sleepImpl,
  } = params;

  const explicitPromptRel = (env.INPUT_DEFAULT_PROMPT_FILE || "").trim();
  const defaultPromptRel = explicitPromptRel || ".github/prompts/pr-review.md";
  const resolvedPromptPath = resolve(actionRoot, defaultPromptRel);
  const relToActionRoot = relative(actionRoot, resolvedPromptPath);
  const isPromptInsideActionRoot =
    Boolean(relToActionRoot) &&
    !isPathEscaping(relToActionRoot) &&
    resolve(actionRoot, relToActionRoot) === resolvedPromptPath;
  const isPromptValidFile =
    isPromptInsideActionRoot &&
    existsSync(resolvedPromptPath) &&
    statSync(resolvedPromptPath).isFile();

  const isSnapshotMode = params.inventory?.baseSha === "SNAPSHOT";
  const isSecurityAudit =
    env.INPUT_SECURITY_AUDIT === "true" ||
    defaultPromptRel.includes("security-audit");
  const defaultContract = isSecurityAudit
    ? BUILTIN_SECURITY_AUDIT_SYSTEM_PROMPT
    : BUILTIN_REVIEW_SYSTEM_PROMPT;

  // 1. Prefer trusted ACTION_PATH (external action installation directory) if available
  const trustedActionPrompt = process.env.ACTION_PATH
    ? resolve(process.env.ACTION_PATH, defaultPromptRel)
    : undefined;
  const isTrustedPromptFile =
    trustedActionPrompt &&
    existsSync(trustedActionPrompt) &&
    statSync(trustedActionPrompt).isFile();

  // Tamper detection is only valid in PR diff mode where untrusted PR diff could tamper prompts
  const isPromptTamperedInPr =
    !isSnapshotMode &&
    Boolean(params.inventory) &&
    [
      ...(params.inventory?.files.map((f) => f.path) ?? []),
      ...(params.inventory?.skipped.excluded.map((s) => s.path) ?? []),
      ...(params.inventory?.skipped.binary.map((s) => s.path) ?? []),
      ...(params.inventory?.skipped.empty.map((s) => s.path) ?? []),
      ...chunkPlan.filesIncluded.map((f) => f.path),
    ].some((p) => p.startsWith(".github/prompts/"));

  let baseReviewContract = defaultContract;
  if (!isPromptInsideActionRoot && explicitPromptRel) {
    throw new Error(
      `指定的提示词文件超出 Action 目录边界: ${explicitPromptRel}`,
    );
  }

  if (isPromptTamperedInPr) {
    logger.warn(
      `检测到当前 PR 修改了审查提示词文件 (${defaultPromptRel})，为防止门禁绕过，本次审查强制使用受信任的内置契约`,
    );
    baseReviewContract = defaultContract;
  } else if (isTrustedPromptFile) {
    baseReviewContract = readFileSync(trustedActionPrompt, "utf8");
  } else if (isPromptValidFile) {
    baseReviewContract = readFileSync(resolvedPromptPath, "utf8");
  } else if (explicitPromptRel) {
    logger.warn(
      `提示词文件不存在 (${explicitPromptRel})，已安全降级为内置代码审查契约`,
    );
  }
  const userAppendPrompt = resolveTextOrFile(env.INPUT_APPEND_SYSTEM_PROMPT, cwd);
  const combinedAppendPrompt = userAppendPrompt
    ? `${baseReviewContract}\n\n${userAppendPrompt}`
    : baseReviewContract;

  const systemPrompt = resolveTextOrFile(env.INPUT_SYSTEM_PROMPT, cwd);
  const contextFiles = parseContextFiles(env.INPUT_CONTEXT_FILES, cwd);

  const userToolsRaw = (env.INPUT_TOOLS || "read,grep,find,ls")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const reviewTools = [...new Set([...userToolsRaw, "submit_review"])];

  const policy = deriveCapabilityPolicy({
    tools: reviewTools,
    excludeTools: env.INPUT_EXCLUDE_TOOLS,
    noBuiltinTools: false,
    noTools: false,
    provider: env.INPUT_PROVIDER,
    model: env.INPUT_MODEL,
    envAllow: env.INPUT_ENV_ALLOW,
    trustProject: false,
    allowMcp: false,
  });

  const submitExtPath = resolveSubmitReviewExtensionPath(actionRoot);
  const effectiveThinking = reviewPlan.thinking ?? configuredThinking;
  const piBin = env.PI_BIN || process.env.PI_BIN || "pi";

  const chunkReports: ChunkReport[] = [];
  const agentDurations: number[] = [];
  const agentUsages: AgentUsage[] = [];
  const rawOutputs: string[] = [];

  const queue = [...chunkPlan.chunks];
  const workers: Promise<void>[] = [];

  const runChunkWorker = async () => {
    while (queue.length > 0) {
      const chunk = queue.shift();
      if (!chunk) break;

      const chunkPrompt = buildReviewPrompt({
        prNumber,
        contextDir,
        chunk: chunkPlan.plannedChunks === 1 ? undefined : chunk,
        totalChunks: chunkPlan.totalChunks,
        plannedChunks: chunkPlan.plannedChunks,
        reviewPlan,
        extraPrompt: env.INPUT_PROMPT || "",
      });

      const spec: AgentSpec = {
        prompt: chunkPrompt,
        systemPrompt,
        appendSystemPrompt: combinedAppendPrompt,
        contextFiles,
        promptTemplate: env.INPUT_PROMPT_TEMPLATE || "",
        model: env.INPUT_MODEL || "",
        provider: env.INPUT_PROVIDER || "",
        thinking: effectiveThinking,
        apiKey: env.INPUT_API_KEY || "",
        mode: "json",
        policy,
        ...(submitExtPath ? { extensions: [submitExtPath] } : {}),
      };

      const sandbox = buildSandboxSpec(spec, env, { githubToken });
      logger.info(
        `Reviewing chunk #${chunk.index}/${chunkPlan.plannedChunks} (${chunk.files.length} files)`,
      );

      const { result: piRes, durationsMs } = await runPiWithRetry(sandbox, {
        piBin,
        cwd,
        mode: "json",
        requiredTool: "submit_review",
        maxRetries: 2,
        baseDelayMs: 1500,
        sleepImpl,
      });

      agentDurations.push(...durationsMs);
      agentUsages.push(piRes.usage);
      if (piRes.stdout) {
        rawOutputs.push(piRes.stdout);
      }

      const submissions = piRes.toolSubmissions.submit_review ?? [];
      if (submissions.length > 0) {
        const lastSubmission = submissions[submissions.length - 1];
        try {
          const validated = validateSubmitReviewInput(lastSubmission);
          const chunkRep = toChunkReport(chunk.index, validated, chunk.files.length);
          writeChunkReport(contextDir, chunkRep);
          chunkReports.push(chunkRep);
          continue;
        } catch (valErr) {
          logger.warn(
            `Chunk #${chunk.index} submit_review 校验未通过: ${valErr instanceof Error ? valErr.message : String(valErr)}`,
          );
        }
      }

      try {
        const fallbackSource = existsSync(reportFile)
          ? readFileSync(reportFile, "utf8")
          : piRes.stdout;
        if (fallbackSource && fallbackSource.trim()) {
          const extracted = extractJsonReport(fallbackSource);
          const validated = validateSubmitReviewInput({
            summary: extracted.summary ?? "完成审查",
            verdict:
              extracted.verdict === "approve" ||
              extracted.verdict === "comment" ||
              extracted.verdict === "request_changes"
                ? extracted.verdict
                : "comment",
            findings: Array.isArray(extracted.findings) ? extracted.findings : [],
            files_reviewed: chunk.files.length,
          });
          const chunkRep = toChunkReport(chunk.index, validated, chunk.files.length);
          writeChunkReport(contextDir, chunkRep);
          chunkReports.push(chunkRep);
        }
      } catch (err) {
        logger.warn(
          `Chunk #${chunk.index} 未产出有效结构化报告: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  };

  const workerCount = Math.min(concurrency, chunkPlan.chunks.length);
  for (let i = 0; i < workerCount; i++) {
    workers.push(runChunkWorker());
  }
  await Promise.all(workers);

  if (rawOutputs.length > 0) {
    writeFileSync(rawResultFile, redactText(rawOutputs.join("\n"), secretValues), "utf8");
  }

  return {
    chunkReports,
    agentDurations,
    mergedUsage: mergeAgentUsages(agentUsages),
  };
}
