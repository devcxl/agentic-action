#!/usr/bin/env node
/**
 * Pi Coding Agent 通用安全执行器
 *
 * 核心职责：
 * 1. 解析 Action 输入（环境变量 INPUT_*），安全组装 pi CLI 参数数组（零 shell 拼接）。
 * 2. 敏感信息保护：命令回显自动脱敏 --api-key；当工具集不包含 bash 时，自动从 pi 子进程剥离 GH_TOKEN/GITHUB_TOKEN。
 * 3. 支持内联文本或文件路径的 prompt / system_prompt / append_system_prompt。
 * 4. 支持空格、逗号、换行分隔的 context_files（仅当文件存在时以 @file 传入）。
 * 5. 使用 `--` 隔离选项与位置参数，防止以 `-` 开头的 prompt 被误解析为 CLI 选项。
 * 6. 实时流式输出 stdout 到终端并落盘，写入 GITHUB_OUTPUT 与 GITHUB_STEP_SUMMARY。
 */

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const MAX_OUTPUT_CHARS = 32_768;

/**
 * 若输入值对应一个已存在的本地文件，则读取其内容；否则作为内联文本返回。
 */
export function resolveTextOrFile(value, cwd = process.cwd()) {
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  // 多行文本直接视为内联内容
  if (trimmed.includes("\n")) return value;
  try {
    const candidate = resolve(cwd, trimmed);
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return readFileSync(candidate, "utf8");
    }
  } catch {
    // 路径过长或非法字符时回退为内联文本
  }
  return value;
}

/**
 * 解析 context_files：支持换行、逗号；若均无则兼容空格分隔。
 */
export function parseContextFiles(raw, cwd = process.cwd()) {
  if (!raw || !raw.trim()) return [];
  const trimmed = raw.trim();
  let tokens;
  if (trimmed.includes("\n") || trimmed.includes(",")) {
    tokens = trimmed.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
  } else {
    tokens = trimmed.split(/\s+/).map((s) => s.trim()).filter(Boolean);
  }

  const resolved = [];
  for (const token of tokens) {
    const clean = token.startsWith("@") ? token.slice(1) : token;
    const fullPath = resolve(cwd, clean);
    if (existsSync(fullPath) && statSync(fullPath).isFile()) {
      resolved.push(`@${clean}`);
    } else {
      console.error(`[run-agent] 忽略不存在的 context_file: ${clean}`);
    }
  }
  return resolved;
}

/**
 * 判断本次运行的工具权限中是否允许执行任意 shell 命令（bash / powershell）。
 * 若未显式禁用且未设置受限白名单，默认内置工具包含 bash。
 */
export function isShellToolEnabled(inputs) {
  if (inputs.noTools === "true" || inputs.noBuiltinTools === "true") {
    return false;
  }
  const excluded = new Set(
    (inputs.excludeTools || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  if (excluded.has("bash") && excluded.has("powershell")) {
    return false;
  }
  if (inputs.tools && inputs.tools.trim()) {
    const allowed = inputs.tools
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    return allowed.some((name) => name === "*" || name === "bash" || name === "+bash" || name === "powershell" || name === "+powershell");
  }
  return !excluded.has("bash");
}

/**
 * 构建 pi CLI 参数与脱敏后的展示参数
 */
export function buildPiInvocation(inputs, cwd = process.cwd()) {
  const prompt = resolveTextOrFile(inputs.prompt, cwd);
  if (!prompt || !prompt.trim()) {
    throw new Error("缺少有效的 prompt（不能为空）");
  }

  const args = ["-p", "--approve"];
  const redactedArgs = ["-p", "--approve"];

  const pushFlag = (flag, val, secret = false) => {
    if (val === undefined || val === null || val === "") return;
    args.push(flag, String(val));
    redactedArgs.push(flag, secret ? "***" : String(val));
  };

  pushFlag("--provider", inputs.provider);
  pushFlag("--model", inputs.model);
  pushFlag("--thinking", inputs.thinking);
  pushFlag("--api-key", inputs.apiKey, true);
  pushFlag("--tools", inputs.tools);
  pushFlag("--exclude-tools", inputs.excludeTools);

  if (inputs.noBuiltinTools === "true") {
    args.push("--no-builtin-tools");
    redactedArgs.push("--no-builtin-tools");
  }
  if (inputs.noTools === "true") {
    args.push("--no-tools");
    redactedArgs.push("--no-tools");
  }

  const systemPrompt = resolveTextOrFile(inputs.systemPrompt, cwd);
  if (systemPrompt) {
    args.push("--system-prompt", systemPrompt);
    redactedArgs.push("--system-prompt", "[system-prompt]");
  }

  const appendSystemPrompt = resolveTextOrFile(inputs.appendSystemPrompt, cwd);
  if (appendSystemPrompt) {
    args.push("--append-system-prompt", appendSystemPrompt);
    redactedArgs.push("--append-system-prompt", "[append-system-prompt]");
  }

  pushFlag("--prompt-template", inputs.promptTemplate);
  pushFlag("--mode", inputs.mode || "text");

  const contextFiles = parseContextFiles(inputs.contextFiles, cwd);

  // 使用 `--` 终止选项解析，防止 @file 或以 `-` 开头的 prompt 被当成 CLI flag
  args.push("--", ...contextFiles, prompt);
  redactedArgs.push("--", ...contextFiles, "[prompt]");

  return { args, redactedArgs, prompt, contextFiles };
}

/**
 * 构建传给 pi 子进程的环境变量：
 * 若未启用 bash/shell 工具，主动剥离 GH_TOKEN / GITHUB_TOKEN，防止被不可信上下文或扩展泄露。
 */
export function buildChildEnv(baseEnv, inputs) {
  const childEnv = {
    ...baseEnv,
    CI: "true",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GH_PROMPT_DISABLED: "1",
  };

  if (!isShellToolEnabled(inputs)) {
    delete childEnv.GH_TOKEN;
    delete childEnv.GITHUB_TOKEN;
  }

  return childEnv;
}

/**
 * 写入 GitHub Actions 多行输出（GITHUB_OUTPUT）
 */
export function writeGitHubOutput(outputs, outputPath = process.env.GITHUB_OUTPUT) {
  if (!outputPath) return;
  const lines = [];
  for (const [key, rawValue] of Object.entries(outputs)) {
    if (rawValue === undefined || rawValue === null) continue;
    const value = String(rawValue);
    if (!value.includes("\n")) {
      lines.push(`${key}=${value}`);
    } else {
      const delimiter = `EOF_${key}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      lines.push(`${key}<<${delimiter}`);
      lines.push(value);
      lines.push(delimiter);
    }
  }
  if (lines.length > 0) {
    appendFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");
  }
}

/**
 * 写入 GitHub Step Summary
 */
export function writeStepSummary(content, mode = "text", summaryPath = process.env.GITHUB_STEP_SUMMARY) {
  if (!summaryPath) return;
  const trimmed = (content || "").trim();
  const lines = ["## Pi Agent Output", ""];
  if (!trimmed) {
    lines.push("_(empty output)_");
  } else if (mode === "json") {
    lines.push("```json", trimmed, "```");
  } else {
    lines.push(trimmed);
  }
  lines.push("");
  appendFileSync(summaryPath, lines.join("\n"), "utf8");
}

export async function runAgent(inputs, {
  piBin = process.env.PI_BIN || "pi",
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  const { args, redactedArgs } = buildPiInvocation(inputs, cwd);
  const childEnv = buildChildEnv(env, inputs);

  const tempBase = env.RUNNER_TEMP || tmpdir();
  const outDir = mkdtempSync(join(tempBase, "pi-run-"));
  const resultFile = inputs.resultFile ? resolve(cwd, inputs.resultFile) : join(outDir, "pi-result.txt");

  console.error(`[run-agent] Executing: ${piBin} ${redactedArgs.join(" ")}`);

  const chunks = [];
  const exitCode = await new Promise((resolveExit, reject) => {
    const child = spawn(piBin, args, {
      cwd,
      env: childEnv,
      stdio: ["ignore", "pipe", "inherit"],
    });

    child.on("error", (err) => reject(err));
    child.stdout.on("data", (chunk) => {
      chunks.push(chunk);
      process.stdout.write(chunk);
    });
    child.on("close", (code) => resolveExit(code ?? 1));
  });

  const fullOutput = Buffer.concat(chunks).toString("utf8");
  writeFileSync(resultFile, fullOutput, "utf8");

  const truncatedResult =
    fullOutput.length > MAX_OUTPUT_CHARS
      ? `${fullOutput.slice(0, MAX_OUTPUT_CHARS)}\n...(truncated, see result_file)`
      : fullOutput;

  writeGitHubOutput(
    {
      result: truncatedResult.trim(),
      result_file: resultFile,
      exit_code: String(exitCode),
    },
    env.GITHUB_OUTPUT,
  );

  if (exitCode === 0 && inputs.writeSummary !== "false") {
    writeStepSummary(fullOutput, inputs.mode || "text", env.GITHUB_STEP_SUMMARY);
  }

  return { exitCode, output: fullOutput, resultFile };
}

export function readInputsFromEnv(env = process.env) {
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
    mode: env.INPUT_MODE ?? "text",
    resultFile: env.INPUT_RESULT_FILE ?? "",
    writeSummary: env.INPUT_WRITE_SUMMARY ?? "true",
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const inputs = readInputsFromEnv(process.env);
  runAgent(inputs)
    .then(({ exitCode }) => {
      if (exitCode !== 0) {
        console.error(`[run-agent] Pi execution exited with code ${exitCode}`);
        process.exit(exitCode);
      }
    })
    .catch((error) => {
      console.error(`[run-agent] Error: ${error.message}`);
      process.exit(1);
    });
}
