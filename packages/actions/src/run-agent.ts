import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  ExitCode,
  type AgentSpec,
  type RunResult,
  type SandboxSpec,
  type ThinkingLevel,
} from "@agentic-action/contracts";
import {
  buildSandboxSpec,
  collectSensitiveValues,
  deriveCapabilityPolicy,
  redactText,
} from "@agentic-action/core";
import {
  createLogger,
  parseContextFiles,
  resolveTextOrFile,
  runPiSubprocess,
  scrubGitCredentials,
  writeGitHubOutput,
  writeRunResult,
  writeStepSummary,
} from "@agentic-action/adapters";

const MAX_OUTPUT_CHARS = 32_768;

export interface RunAgentInputs {
  prompt: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  contextFiles?: string;
  promptTemplate?: string;
  model: string;
  provider?: string;
  thinking?: string;
  apiKey?: string;
  tools?: string;
  excludeTools?: string;
  noBuiltinTools?: string | boolean;
  noTools?: string | boolean;
  envAllow?: string;
  trustProject?: string | boolean;
  allowMcp?: string | boolean;
  mode?: "text" | "json";
  resultFile?: string;
  writeSummary?: string | boolean;
  timeoutMs?: number;
}

export function buildPiInvocation(
  inputs: RunAgentInputs,
  cwd = process.cwd(),
  hostEnv: Readonly<Record<string, string | undefined>> = process.env,
): {
  args: string[];
  redactedArgs: string[];
  prompt: string;
  contextFiles: string[];
  sandbox: SandboxSpec;
} {
  const prompt = resolveTextOrFile(inputs.prompt, cwd);
  if (!prompt || !prompt.trim()) {
    throw new Error("缺少有效的 prompt（不能为空）");
  }
  const systemPrompt = resolveTextOrFile(inputs.systemPrompt, cwd);
  const appendSystemPrompt = resolveTextOrFile(inputs.appendSystemPrompt, cwd);
  const contextFiles = parseContextFiles(inputs.contextFiles, cwd);

  const policy = deriveCapabilityPolicy({
    tools: inputs.tools,
    excludeTools: inputs.excludeTools,
    noBuiltinTools: inputs.noBuiltinTools,
    noTools: inputs.noTools,
    provider: inputs.provider,
    model: inputs.model,
    envAllow: inputs.envAllow,
    trustProject:
      inputs.trustProject === true || inputs.trustProject === "true",
    allowMcp: inputs.allowMcp === true || inputs.allowMcp === "true",
  });

  const spec: AgentSpec = {
    prompt,
    systemPrompt,
    appendSystemPrompt,
    contextFiles,
    promptTemplate: inputs.promptTemplate,
    model: inputs.model,
    provider: inputs.provider,
    thinking: (inputs.thinking ?? "") as ThinkingLevel | "",
    apiKey: inputs.apiKey,
    mode: inputs.mode || "text",
    policy,
  };

  const sandbox = buildSandboxSpec(spec, hostEnv, {
    githubToken:
      hostEnv.INPUT_GITHUB_TOKEN || hostEnv.GH_TOKEN || hostEnv.GITHUB_TOKEN,
  });

  return {
    args: sandbox.argv,
    redactedArgs: sandbox.redactedArgv,
    prompt,
    contextFiles,
    sandbox,
  };
}

export async function runAgent(
  inputs: RunAgentInputs,
  options: {
    piBin?: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    streamToStdout?: boolean;
  } = {},
): Promise<{
  exitCode: ExitCode;
  piExitCode: number;
  output: string;
  resultFile: string;
  envelopeFile: string;
  result: RunResult;
}> {
  const startMs = Date.now();
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const piBin = options.piBin || env.PI_BIN || "pi";

  const secretValues = collectSensitiveValues(env, [inputs.apiKey]);
  const logger = createLogger("run-agent", secretValues);

  scrubGitCredentials(cwd);

  const { sandbox } = buildPiInvocation(inputs, cwd, env);
  const tempBase = env.RUNNER_TEMP || tmpdir();
  const outDir = mkdtempSync(join(tempBase, "pi-run-"));
  const resultFile = inputs.resultFile
    ? resolve(cwd, inputs.resultFile)
    : join(outDir, "pi-result.txt");
  const artifactDir = inputs.resultFile ? dirname(resultFile) : outDir;

  logger.info(`Executing: ${piBin} ${sandbox.redactedArgv.join(" ")}`);

  const agentStart = Date.now();
  const streamRes = await runPiSubprocess(sandbox, {
    piBin,
    cwd,
    mode: inputs.mode || "text",
    timeoutMs: options.timeoutMs ?? inputs.timeoutMs,
    streamToStdout: options.streamToStdout ?? true,
  });
  const agentDuration = Date.now() - agentStart;

  const redactedOutput = redactText(streamRes.stdout, secretValues);
  writeFileSync(resultFile, redactedOutput, "utf8");

  const truncatedResult =
    redactedOutput.length > MAX_OUTPUT_CHARS
      ? `${redactedOutput.slice(0, MAX_OUTPUT_CHARS)}\n...(truncated, see result_file)`
      : redactedOutput;

  const exitCode =
    streamRes.exitCode === 0 ? ExitCode.Ok : ExitCode.Infrastructure;

  const envelope: RunResult = {
    schemaVersion: 2,
    status: exitCode === ExitCode.Ok ? "ok" : "infrastructure_error",
    exitCode,
    verdict: exitCode === ExitCode.Ok ? "ok" : "error",
    timings: {
      agentMs: [agentDuration],
      totalMs: Date.now() - startMs,
    },
    agentUsage: streamRes.usage,
    ...(exitCode !== ExitCode.Ok
      ? {
          error:
            streamRes.errorMessage ||
            `Pi process exited with code ${streamRes.exitCode}`,
        }
      : {}),
  };

  const envelopeFile = writeRunResult(artifactDir, envelope, secretValues);

  writeGitHubOutput(
    {
      result: truncatedResult.trim(),
      result_file: resultFile,
      exit_code: String(exitCode),
    },
    env.GITHUB_OUTPUT,
    secretValues,
  );

  const shouldWriteSummary =
    inputs.writeSummary !== false && inputs.writeSummary !== "false";
  if (exitCode === ExitCode.Ok && shouldWriteSummary) {
    writeStepSummary(
      redactedOutput,
      inputs.mode || "text",
      env.GITHUB_STEP_SUMMARY,
      secretValues,
    );
  }

  return {
    exitCode,
    piExitCode: streamRes.exitCode,
    output: redactedOutput,
    resultFile,
    envelopeFile,
    result: envelope,
  };
}

export function readInputsFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RunAgentInputs {
  const modeRaw = (env.INPUT_MODE ?? "text").trim();
  const mode: "text" | "json" = modeRaw === "json" ? "json" : "text";
  const timeoutRaw = Number(env.INPUT_TIMEOUT_MS ?? "");

  return {
    prompt: env.INPUT_PROMPT ?? "",
    systemPrompt: env.INPUT_SYSTEM_PROMPT ?? "",
    appendSystemPrompt: env.INPUT_APPEND_SYSTEM_PROMPT ?? "",
    contextFiles: env.INPUT_CONTEXT_FILES ?? "",
    promptTemplate: env.INPUT_PROMPT_TEMPLATE ?? "",
    model: env.INPUT_MODEL ?? "",
    provider: env.INPUT_PROVIDER ?? "",
    thinking: env.INPUT_THINKING ?? "",
    apiKey: env.INPUT_API_KEY ?? "",
    tools: env.INPUT_TOOLS ?? "",
    excludeTools: env.INPUT_EXCLUDE_TOOLS ?? "",
    noBuiltinTools: env.INPUT_NO_BUILTIN_TOOLS ?? "false",
    noTools: env.INPUT_NO_TOOLS ?? "false",
    envAllow: env.INPUT_ENV_ALLOW ?? "",
    trustProject: env.INPUT_TRUST_PROJECT ?? "false",
    allowMcp: env.INPUT_ALLOW_MCP ?? "false",
    mode,
    resultFile: env.INPUT_RESULT_FILE ?? "",
    writeSummary: env.INPUT_WRITE_SUMMARY ?? "true",
    ...(Number.isFinite(timeoutRaw) && timeoutRaw > 0
      ? { timeoutMs: timeoutRaw }
      : {}),
  };
}

if (
  process.argv[1] &&
  import.meta.url === `file://${resolve(process.argv[1])}`
) {
  const inputs = readInputsFromEnv(process.env);
  runAgent(inputs)
    .then(({ exitCode }) => {
      if (exitCode !== ExitCode.Ok) {
        process.stderr.write(`[run-agent] Exiting with code ${exitCode}\n`);
        process.exit(exitCode);
      }
    })
    .catch((error) => {
      process.stderr.write(
        `[run-agent] Error: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(ExitCode.Infrastructure);
    });
}
