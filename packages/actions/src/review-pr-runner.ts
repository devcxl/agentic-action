import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentSpec,
  AgentUsage,
  ChunkPlan,
  ChunkReport,
  ReviewPlan,
  ThinkingLevel,
} from "@agentic-action/contracts";
import {
  buildSandboxSpec,
  deriveCapabilityPolicy,
  extractJsonReport,
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
  buildReviewPrompt,
} from "./review-pr-linkage.ts";

function resolveSubmitReviewExtensionPath(actionRoot: string): string | undefined {
  const candidate = join(actionRoot, "packages/extensions/src/submit-review.ts");
  return existsSync(candidate) ? candidate : undefined;
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

  const defaultPromptPath = join(actionRoot, ".github/prompts/pr-review.md");
  const baseReviewContract = existsSync(defaultPromptPath)
    ? readFileSync(defaultPromptPath, "utf8")
    : BUILTIN_REVIEW_SYSTEM_PROMPT;
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
