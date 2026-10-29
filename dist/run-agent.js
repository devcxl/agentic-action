import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);

// packages/actions/src/run-agent.ts
import { mkdtempSync, writeFileSync as writeFileSync2 } from "node:fs";
import { tmpdir } from "node:os";
import { dirname as dirname2, join as join2, resolve as resolve2 } from "node:path";

// packages/core/src/capability/policy.ts
var BASE_SAFE_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "RUNNER_TEMP",
  "LANG",
  "LC_ALL",
  "TERM",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "PI_CODING_AGENT_DIR",
  "PI_CI_LOG",
  "HALF_CABBAGE_BASE_URL",
  "HALF_CABBAGE_DEBUG",
  "MODELS_DEV_URL"
];
var FIXED_CHILD_ENV = {
  CI: "true",
  GIT_PAGER: "cat",
  PAGER: "cat",
  GH_PROMPT_DISABLED: "1"
};
var PROVIDER_ENV_MAP = {
  "half-cabbage": ["HALF_CABBAGE_API_KEY", "HALF_CABBAGE_KEY", "HALF_CABBAGE_BASE_URL"],
  openai: ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
  anthropic: [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_OAUTH_TOKEN",
    "ANTHROPIC_BASE_URL"
  ],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  groq: ["GROQ_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  minimax: ["MINIMAX_API_KEY", "MINIMAX_CN_API_KEY"],
  moonshot: ["MOONSHOT_API_KEY", "KIMI_API_KEY"],
  kimi: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
  zai: ["ZAI_API_KEY", "ZAI_CODING_CN_API_KEY"],
  qwen: ["QWEN_TOKEN_PLAN_API_KEY", "QWEN_TOKEN_PLAN_CN_API_KEY"],
  xiaomi: [
    "XIAOMI_API_KEY",
    "XIAOMI_TOKEN_PLAN_CN_API_KEY",
    "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
    "XIAOMI_TOKEN_PLAN_SGP_API_KEY"
  ],
  opencode: ["OPENCODE_API_KEY"],
  "vercel-ai-gateway": ["AI_GATEWAY_API_KEY"],
  cloudflare: ["CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID"],
  "cloudflare-workers-ai": ["CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID"],
  bedrock: [
    "AWS_BEARER_TOKEN_BEDROCK",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_REGION"
  ],
  xai: ["XAI_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  fireworks: ["FIREWORKS_API_KEY"],
  together: ["TOGETHER_API_KEY"],
  baseten: ["BASETEN_API_KEY"],
  huggingface: ["HF_TOKEN"],
  radius: ["RADIUS_API_KEY"]
};
function inferProvider(provider, model) {
  const explicit = (provider ?? "").trim().toLowerCase();
  if (explicit) return explicit;
  const rawModel = (model ?? "").trim().toLowerCase();
  if (!rawModel) return "";
  if (rawModel.includes("/")) {
    const prefix = rawModel.split("/")[0]?.trim() ?? "";
    if (prefix) return prefix;
  }
  if (rawModel.startsWith("gpt-") || rawModel.startsWith("o1") || rawModel.startsWith("o3") || rawModel.startsWith("o4") || rawModel.startsWith("chatgpt-")) {
    return "openai";
  }
  if (rawModel.startsWith("claude-")) return "anthropic";
  if (rawModel.startsWith("gemini-")) return "google";
  if (rawModel.startsWith("deepseek-")) return "deepseek";
  if (rawModel.startsWith("minimax-")) return "minimax";
  if (rawModel.startsWith("mistral-") || rawModel.startsWith("codestral")) return "mistral";
  if (rawModel.startsWith("kimi-") || rawModel.startsWith("moonshot-")) return "moonshot";
  if (rawModel.startsWith("qwen")) return "qwen";
  if (rawModel.startsWith("grok-")) return "xai";
  return "";
}
function resolveProviderEnvKeys(provider, model) {
  const inferred = inferProvider(provider, model);
  if (!inferred) return [];
  const keys = PROVIDER_ENV_MAP[inferred];
  return keys ? [...keys] : [];
}
function isShellEnabledInPolicy(policy) {
  if (policy.noTools || policy.noBuiltinTools) return false;
  const excluded = new Set(
    (policy.excludeTools ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean)
  );
  if (excluded.has("bash") && excluded.has("powershell")) {
    return false;
  }
  if (policy.tools.length > 0) {
    const allowed = policy.tools.map((t) => t.trim().toLowerCase()).filter(Boolean);
    return allowed.some(
      (name) => (name === "*" || name === "bash" || name === "powershell") && !excluded.has(name === "*" ? "bash" : name)
    );
  }
  return !excluded.has("bash");
}
function deriveCapabilityPolicy(inputs) {
  const splitCsv = (val) => {
    if (!val) return [];
    if (Array.isArray(val)) {
      return val.map((s) => String(s).trim()).filter(Boolean);
    }
    return String(val).split(",").map((s) => s.trim().replace(/^[+-]/, "")).filter(Boolean);
  };
  const noTools = inputs.noTools === true || inputs.noTools === "true";
  const noBuiltinTools = inputs.noBuiltinTools === true || inputs.noBuiltinTools === "true";
  const tools = noTools ? [] : splitCsv(inputs.tools);
  const excludeTools = splitCsv(inputs.excludeTools);
  const providerEnv = resolveProviderEnvKeys(inputs.provider, inputs.model);
  const explicitEnvAllow = splitCsv(inputs.envAllow);
  const envAllow = [.../* @__PURE__ */ new Set([...providerEnv, ...explicitEnvAllow])];
  return {
    tools,
    excludeTools,
    noBuiltinTools,
    noTools,
    envAllow,
    trustProject: inputs.trustProject ?? false,
    allowMcp: inputs.allowMcp ?? false
  };
}
function buildSandboxSpec(spec, hostEnv, options = {}) {
  const prompt = (spec.prompt ?? "").trim();
  if (!prompt) {
    throw new Error("\u7F3A\u5C11\u6709\u6548\u7684 prompt\uFF08\u4E0D\u80FD\u4E3A\u7A7A\uFF09");
  }
  const { policy } = spec;
  const trustFlag = policy.trustProject ? "--approve" : "--no-approve";
  const argv = ["-p", trustFlag];
  const redactedArgv = ["-p", trustFlag];
  if (!policy.allowMcp) {
    argv.push("--no-mcp");
    redactedArgv.push("--no-mcp");
  }
  const pushFlag = (flag, val, secret = false) => {
    if (val === void 0 || val === null || val === "") return;
    argv.push(flag, String(val));
    redactedArgv.push(flag, secret ? "***" : String(val));
  };
  pushFlag("--provider", spec.provider);
  pushFlag("--model", spec.model);
  pushFlag("--thinking", spec.thinking);
  pushFlag("--api-key", spec.apiKey, true);
  if (policy.noTools) {
    argv.push("--no-tools");
    redactedArgv.push("--no-tools");
  } else {
    if (policy.noBuiltinTools) {
      argv.push("--no-builtin-tools");
      redactedArgv.push("--no-builtin-tools");
    }
    if (policy.tools.length > 0) {
      const joined = policy.tools.join(",");
      pushFlag("--tools", joined);
    }
    if (policy.excludeTools && policy.excludeTools.length > 0) {
      pushFlag("--exclude-tools", policy.excludeTools.join(","));
    }
  }
  if (spec.extensions && spec.extensions.length > 0) {
    for (const ext of spec.extensions) {
      if (ext && ext.trim()) {
        pushFlag("-e", ext.trim());
      }
    }
  }
  if (spec.systemPrompt && spec.systemPrompt.trim()) {
    argv.push("--system-prompt", spec.systemPrompt);
    redactedArgv.push("--system-prompt", "[system-prompt]");
  }
  if (spec.appendSystemPrompt && spec.appendSystemPrompt.trim()) {
    argv.push("--append-system-prompt", spec.appendSystemPrompt);
    redactedArgv.push("--append-system-prompt", "[append-system-prompt]");
  }
  pushFlag("--prompt-template", spec.promptTemplate);
  pushFlag("--mode", spec.mode || "text");
  const contextFiles = spec.contextFiles ?? [];
  argv.push("--", ...contextFiles, spec.prompt);
  redactedArgv.push("--", ...contextFiles, "[prompt]");
  const env = { ...FIXED_CHILD_ENV };
  const allowedKeys = /* @__PURE__ */ new Set([
    ...BASE_SAFE_ENV_KEYS,
    ...policy.envAllow
  ]);
  for (const key of allowedKeys) {
    if (key.startsWith("INPUT_")) continue;
    if (key === "GITHUB_TOKEN" || key === "GH_TOKEN") continue;
    const val = hostEnv[key];
    if (typeof val === "string" && val.length > 0) {
      env[key] = val;
    }
  }
  if (isShellEnabledInPolicy(policy)) {
    const token = options.githubToken || hostEnv.GH_TOKEN || hostEnv.GITHUB_TOKEN;
    if (token && token.trim()) {
      env.GH_TOKEN = token.trim();
    }
  }
  return { argv, env, redactedArgv };
}
function collectSensitiveValues(hostEnv, extraSecrets = []) {
  const values = /* @__PURE__ */ new Set();
  const addIfSecret = (val) => {
    if (!val) return;
    const trimmed = val.trim();
    if (trimmed.length >= 8) {
      values.add(trimmed);
    }
  };
  for (const [key, val] of Object.entries(hostEnv)) {
    if (!val) continue;
    if (/(?:_KEY|_TOKEN|_SECRET|PASSWORD|AUTHORIZATION)$/i.test(key) || /^INPUT_(?:API_KEY|GITHUB_TOKEN|TYPESAFE_API_KEY)$/i.test(key)) {
      addIfSecret(val);
    }
  }
  for (const extra of extraSecrets) {
    addIfSecret(extra);
  }
  return [...values].sort((a, b) => b.length - a.length);
}
function redactText(text, secretValues = []) {
  if (!text) return "";
  let out = text;
  for (const secret of secretValues) {
    if (secret && secret.length >= 8 && out.includes(secret)) {
      out = out.split(secret).join("***");
    }
  }
  out = out.replace(/(--api-key(?:\s+|=))([^\s"']+)/gi, "$1***");
  out = out.replace(
    /(Authorization:\s*(?:Bearer|token|Basic)\s+)([^\s"'\\]+)/gi,
    "$1***"
  );
  out = out.replace(
    /\b([A-Za-z0-9_]*(?:_KEY|_TOKEN|_SECRET)=)([^\s"']+)/g,
    "$1***"
  );
  out = out.replace(/\b(gh[pousr]_[A-Za-z0-9_]{8,})\b/g, "***");
  return out;
}

// packages/adapters/src/git.ts
import { execFileSync } from "node:child_process";
function execGit(args, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  try {
    return execFileSync("git", [...args], {
      cwd,
      env,
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
      timeout: options.timeoutMs ?? 12e4,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    if (options.allowFail) return "";
    const errObj = error;
    const stderr = errObj.stderr ? String(errObj.stderr).trim() : "";
    throw new Error(
      `git ${args.join(" ")} \u5931\u8D25: ${stderr || errObj.message || String(error)}`
    );
  }
}
function scrubGitCredentials(cwd = process.cwd()) {
  const unsetKeys = [];
  const matched = execGit(
    ["config", "--local", "--name-only", "--get-regexp", "^http\\..*\\.extraheader$"],
    { cwd, allowFail: true }
  ).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const keysToClean = /* @__PURE__ */ new Set([
    "http.https://github.com/.extraheader",
    ...matched
  ]);
  for (const key of keysToClean) {
    execGit(["config", "--local", "--unset-all", key], {
      cwd,
      allowFail: true
    });
    if (matched.includes(key)) {
      unsetKeys.push(key);
    }
  }
  return unsetKeys;
}

// packages/adapters/src/log.ts
function redact(text, secretValues = []) {
  return redactText(text, secretValues);
}
function createLogger(scope, secretValues = [], writer = (line) => process.stderr.write(`${line}
`)) {
  const formatLine = (level, msg, fields) => {
    const kvParts = [`level=${level}`, `scope=${scope}`];
    if (fields) {
      for (const [k, v] of Object.entries(fields)) {
        if (v === void 0) continue;
        const serialized = typeof v === "string" ? v : JSON.stringify(v);
        kvParts.push(`${k}=${serialized}`);
      }
    }
    const raw = `[${scope}] ${msg}${kvParts.length > 2 ? ` (${kvParts.slice(2).join(" ")})` : ""}`;
    return redact(raw, secretValues);
  };
  return {
    info(msg, fields) {
      writer(formatLine("info", msg, fields));
    },
    warn(msg, fields) {
      writer(formatLine("warn", msg, fields));
    },
    error(msg, fields) {
      writer(formatLine("error", msg, fields));
    }
  };
}

// packages/adapters/src/pi.ts
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
function splitLfLines(buffer) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer.charCodeAt(i) === 10) {
      const end = i > start && buffer.charCodeAt(i - 1) === 13 ? i - 1 : i;
      lines.push(buffer.slice(start, end));
      start = i + 1;
    }
  }
  return {
    lines,
    remainder: buffer.slice(start)
  };
}
function createEmptyUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    costTotal: 0
  };
}
function accumulateUsage(target, rawUsage) {
  if (!rawUsage || typeof rawUsage !== "object") return;
  const u = rawUsage;
  const addNum = (val) => typeof val === "number" && Number.isFinite(val) && val > 0 ? val : 0;
  target.inputTokens += addNum(u.input);
  target.outputTokens += addNum(u.output);
  target.cacheReadTokens += addNum(u.cacheRead);
  target.cacheWriteTokens += addNum(u.cacheWrite);
  target.reasoningTokens += addNum(u.reasoning);
  target.totalTokens += addNum(u.totalTokens);
  if (u.cost && typeof u.cost === "object") {
    const costObj = u.cost;
    target.costTotal = Number(
      (target.costTotal + addNum(costObj.total)).toFixed(6)
    );
  }
}
function isTransientErrorMessage(msg) {
  if (!msg) return false;
  return /\b(429|500|502|503|504|529)\b|overloaded|rate[_\s-]?limit|timeout|timed?\s*out|econnreset|etimedout|socket hang up/i.test(
    msg
  );
}
async function runPiSubprocess(sandbox, options = {}) {
  const piBin = options.piBin || "pi";
  const cwd = options.cwd ?? process.cwd();
  const mode = options.mode ?? (sandbox.argv.includes("json") ? "json" : "text");
  const streamToStdout = options.streamToStdout ?? mode === "text";
  const usage = createEmptyUsage();
  const toolSubmissions = {};
  const recordedToolCallIds = /* @__PURE__ */ new Set();
  const textBlocks = [];
  const rawChunks = [];
  let settled = false;
  let aborted = false;
  let timedOut = false;
  let corruptedLines = 0;
  let transientError;
  let errorMessage;
  let lineRemainder = "";
  const decoder = new StringDecoder("utf8");
  const recordToolPayload = (toolName, payload, callId) => {
    if (!toolName || payload === void 0 || payload === null) return;
    if (callId) {
      if (recordedToolCallIds.has(callId)) return;
      recordedToolCallIds.add(callId);
    }
    if (!toolSubmissions[toolName]) {
      toolSubmissions[toolName] = [];
    }
    toolSubmissions[toolName].push(payload);
  };
  const handleAssistantMessage = (msg, countUsage) => {
    if (msg.role !== "assistant") return;
    if (countUsage) {
      accumulateUsage(usage, msg.usage);
    }
    if (msg.stopReason === "error" || msg.stopReason === "aborted") {
      if (msg.stopReason === "aborted") aborted = true;
      const errText = typeof msg.errorMessage === "string" ? msg.errorMessage : "";
      if (errText) {
        errorMessage = errText;
        if (isTransientErrorMessage(errText) || usage.totalTokens > 0 && /invalid 'authorization' header or token/i.test(errText)) {
          transientError = errText;
        }
      }
    }
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (!block || typeof block !== "object") continue;
        const b = block;
        if (b.type === "text" && typeof b.text === "string") {
          textBlocks.push(b.text);
        } else if (b.type === "toolCall" && typeof b.name === "string" && b.arguments && typeof b.arguments === "object") {
          const callId = typeof b.id === "string" ? `arg:${b.id}` : void 0;
          recordToolPayload(b.name, b.arguments, callId);
        }
      }
    }
  };
  const processJsonLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event;
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        corruptedLines += 1;
        return;
      }
      event = parsed;
    } catch {
      corruptedLines += 1;
      return;
    }
    const type = event.type;
    if (type === "tool_execution_end") {
      const toolName = typeof event.toolName === "string" ? event.toolName : "";
      const isErr = event.isError === true;
      const callId = typeof event.toolCallId === "string" ? event.toolCallId : void 0;
      if (!isErr && toolName && event.result && typeof event.result === "object") {
        const resObj = event.result;
        const payload = resObj.details ?? resObj.structuredContent;
        if (payload !== void 0) {
          recordToolPayload(toolName, payload, callId);
        }
      }
    } else if (type === "turn_end") {
      if (event.message && typeof event.message === "object") {
        handleAssistantMessage(
          event.message,
          true
        );
      }
      if (Array.isArray(event.toolResults)) {
        for (const tr of event.toolResults) {
          if (!tr || typeof tr !== "object") continue;
          const trObj = tr;
          const toolName = typeof trObj.toolName === "string" ? trObj.toolName : "";
          const callId = typeof trObj.toolCallId === "string" ? trObj.toolCallId : void 0;
          if (trObj.isError !== true && toolName) {
            const payload = trObj.details ?? trObj.structuredContent;
            if (payload !== void 0) {
              recordToolPayload(toolName, payload, callId);
            }
          }
        }
      }
    } else if (type === "message_end") {
      if (event.message && typeof event.message === "object") {
        const msg = event.message;
        if (msg.role === "assistant" && msg.stopReason === "error") {
          handleAssistantMessage(msg, false);
        }
      }
    } else if (type === "auto_retry_end") {
      if (event.success === false && typeof event.finalError === "string") {
        errorMessage = event.finalError;
        if (isTransientErrorMessage(event.finalError)) {
          transientError = event.finalError;
        }
      }
    } else if (type === "agent_settled") {
      settled = true;
      if (event.aborted === true) {
        aborted = true;
      }
    }
  };
  const exitCode = await new Promise((resolveExit, reject) => {
    const child = spawn(piBin, sandbox.argv, {
      cwd,
      env: sandbox.env,
      stdio: ["ignore", "pipe", "inherit"]
    });
    let timer;
    let killTimer;
    const cleanupTimers = () => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
    };
    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        transientError = `Pi process timed out after ${options.timeoutMs}ms`;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          child.kill("SIGKILL");
        }, 2e3);
      }, options.timeoutMs);
    }
    const onAbort = () => {
      aborted = true;
      child.kill("SIGTERM");
    };
    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }
    child.on("error", (err) => {
      cleanupTimers();
      options.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.stdout.on("data", (chunk) => {
      rawChunks.push(chunk);
      if (streamToStdout) {
        process.stdout.write(chunk);
      }
      if (mode === "json") {
        lineRemainder += decoder.write(chunk);
        const { lines, remainder } = splitLfLines(lineRemainder);
        lineRemainder = remainder;
        for (const line of lines) {
          processJsonLine(line);
        }
      }
    });
    child.on("close", (code, signal) => {
      cleanupTimers();
      options.signal?.removeEventListener("abort", onAbort);
      if (mode === "json") {
        lineRemainder += decoder.end();
        const { lines, remainder } = splitLfLines(lineRemainder);
        for (const line of lines) {
          processJsonLine(line);
        }
        if (remainder.trim()) {
          processJsonLine(remainder);
        }
      }
      if (signal && !timedOut) {
        aborted = true;
      }
      resolveExit(timedOut ? 124 : code ?? 1);
    });
  });
  const fullStdout = Buffer.concat(rawChunks).toString("utf8");
  const textOutput = mode === "json" && textBlocks.length > 0 ? textBlocks.join("\n") : fullStdout;
  return {
    exitCode,
    stdout: fullStdout,
    textOutput,
    toolSubmissions,
    usage,
    settled,
    aborted,
    timedOut,
    corruptedLines,
    ...transientError ? { transientError } : {},
    ...errorMessage ? { errorMessage } : {}
  };
}

// packages/adapters/src/workspace.ts
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
function resolveTextOrFile(value, cwd = process.cwd()) {
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.includes("\n")) return value;
  try {
    const candidate = resolve(cwd, trimmed);
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return readFileSync(candidate, "utf8");
    }
  } catch {
  }
  return value;
}
function parseContextFiles(raw, cwd = process.cwd()) {
  if (!raw || !raw.trim()) return [];
  const trimmed = raw.trim();
  const tokens = trimmed.includes("\n") || trimmed.includes(",") ? trimmed.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean) : trimmed.split(/\s+/).map((s) => s.trim()).filter(Boolean);
  const resolved = [];
  for (const token of tokens) {
    const clean = token.startsWith("@") ? token.slice(1) : token;
    const fullPath = resolve(cwd, clean);
    if (existsSync(fullPath) && statSync(fullPath).isFile()) {
      resolved.push(`@${clean}`);
    } else {
      process.stderr.write(`[workspace] \u5FFD\u7565\u4E0D\u5B58\u5728\u7684 context_file: ${clean}
`);
    }
  }
  return resolved;
}
function writeRunResult(artifactDir, result, secretValues = []) {
  mkdirSync(artifactDir, { recursive: true });
  const filePath = join(artifactDir, "result.json");
  const serialized = redactText(
    `${JSON.stringify(result, null, 2)}
`,
    secretValues
  );
  writeFileSync(filePath, serialized, "utf8");
  return filePath;
}
function writeGitHubOutput(outputs, outputPath = process.env.GITHUB_OUTPUT, secretValues = []) {
  if (!outputPath) return;
  const lines = [];
  for (const [key, rawValue] of Object.entries(outputs)) {
    if (rawValue === void 0 || rawValue === null) continue;
    const value = redactText(String(rawValue), secretValues);
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
    mkdirSync(dirname(outputPath), { recursive: true });
    appendFileSync(outputPath, `${lines.join("\n")}
`, "utf8");
  }
}
function writeStepSummary(content, mode = "text", summaryPath = process.env.GITHUB_STEP_SUMMARY, secretValues = [], heading = "## Pi Agent Output") {
  if (!summaryPath) return;
  const redacted = redactText((content || "").trim(), secretValues);
  const lines = [heading, ""];
  if (!redacted) {
    lines.push("_(empty output)_");
  } else if (mode === "json") {
    lines.push("```json", redacted, "```");
  } else {
    lines.push(redacted);
  }
  lines.push("");
  mkdirSync(dirname(summaryPath), { recursive: true });
  appendFileSync(summaryPath, lines.join("\n"), "utf8");
}

// packages/actions/src/run-agent.ts
var MAX_OUTPUT_CHARS = 32768;
function buildPiInvocation(inputs, cwd = process.cwd(), hostEnv = process.env) {
  const prompt = resolveTextOrFile(inputs.prompt, cwd);
  if (!prompt || !prompt.trim()) {
    throw new Error("\u7F3A\u5C11\u6709\u6548\u7684 prompt\uFF08\u4E0D\u80FD\u4E3A\u7A7A\uFF09");
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
    trustProject: inputs.trustProject === true || inputs.trustProject === "true",
    allowMcp: inputs.allowMcp === true || inputs.allowMcp === "true"
  });
  const spec = {
    prompt,
    systemPrompt,
    appendSystemPrompt,
    contextFiles,
    promptTemplate: inputs.promptTemplate,
    model: inputs.model,
    provider: inputs.provider,
    thinking: inputs.thinking ?? "",
    apiKey: inputs.apiKey,
    mode: inputs.mode || "text",
    policy
  };
  const sandbox = buildSandboxSpec(spec, hostEnv, {
    githubToken: hostEnv.INPUT_GITHUB_TOKEN || hostEnv.GH_TOKEN || hostEnv.GITHUB_TOKEN
  });
  return {
    args: sandbox.argv,
    redactedArgs: sandbox.redactedArgv,
    prompt,
    contextFiles,
    sandbox
  };
}
async function runAgent(inputs, options = {}) {
  const startMs = Date.now();
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const piBin = options.piBin || env.PI_BIN || "pi";
  const secretValues = collectSensitiveValues(env, [inputs.apiKey]);
  const logger = createLogger("run-agent", secretValues);
  scrubGitCredentials(cwd);
  const { sandbox } = buildPiInvocation(inputs, cwd, env);
  const tempBase = env.RUNNER_TEMP || tmpdir();
  const outDir = mkdtempSync(join2(tempBase, "pi-run-"));
  const resultFile = inputs.resultFile ? resolve2(cwd, inputs.resultFile) : join2(outDir, "pi-result.txt");
  const artifactDir = inputs.resultFile ? dirname2(resultFile) : outDir;
  logger.info(`Executing: ${piBin} ${sandbox.redactedArgv.join(" ")}`);
  const agentStart = Date.now();
  const streamRes = await runPiSubprocess(sandbox, {
    piBin,
    cwd,
    mode: inputs.mode || "text",
    timeoutMs: options.timeoutMs ?? inputs.timeoutMs,
    streamToStdout: options.streamToStdout ?? true
  });
  const agentDuration = Date.now() - agentStart;
  const redactedOutput = redactText(streamRes.stdout, secretValues);
  writeFileSync2(resultFile, redactedOutput, "utf8");
  const truncatedResult = redactedOutput.length > MAX_OUTPUT_CHARS ? `${redactedOutput.slice(0, MAX_OUTPUT_CHARS)}
...(truncated, see result_file)` : redactedOutput;
  const exitCode = streamRes.exitCode === 0 ? 0 /* Ok */ : 30 /* Infrastructure */;
  const envelope = {
    schemaVersion: 2,
    status: exitCode === 0 /* Ok */ ? "ok" : "infrastructure_error",
    exitCode,
    verdict: exitCode === 0 /* Ok */ ? "ok" : "error",
    timings: {
      agentMs: [agentDuration],
      totalMs: Date.now() - startMs
    },
    agentUsage: streamRes.usage,
    ...exitCode !== 0 /* Ok */ ? {
      error: streamRes.errorMessage || `Pi process exited with code ${streamRes.exitCode}`
    } : {}
  };
  const envelopeFile = writeRunResult(artifactDir, envelope, secretValues);
  writeGitHubOutput(
    {
      result: truncatedResult.trim(),
      result_file: resultFile,
      exit_code: String(exitCode)
    },
    env.GITHUB_OUTPUT,
    secretValues
  );
  const shouldWriteSummary = inputs.writeSummary !== false && inputs.writeSummary !== "false";
  if (exitCode === 0 /* Ok */ && shouldWriteSummary) {
    writeStepSummary(
      redactedOutput,
      inputs.mode || "text",
      env.GITHUB_STEP_SUMMARY,
      secretValues
    );
  }
  return {
    exitCode,
    piExitCode: streamRes.exitCode,
    output: redactedOutput,
    resultFile,
    envelopeFile,
    result: envelope
  };
}
function readInputsFromEnv(env = process.env) {
  const modeRaw = (env.INPUT_MODE ?? "text").trim();
  const mode = modeRaw === "json" ? "json" : "text";
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
    ...Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? { timeoutMs: timeoutRaw } : {}
  };
}
if (process.argv[1] && import.meta.url === `file://${resolve2(process.argv[1])}`) {
  const inputs = readInputsFromEnv(process.env);
  runAgent(inputs).then(({ exitCode }) => {
    if (exitCode !== 0 /* Ok */) {
      process.stderr.write(`[run-agent] Exiting with code ${exitCode}
`);
      process.exit(exitCode);
    }
  }).catch((error) => {
    process.stderr.write(
      `[run-agent] Error: ${error instanceof Error ? error.message : String(error)}
`
    );
    process.exit(30 /* Infrastructure */);
  });
}
export {
  buildPiInvocation,
  readInputsFromEnv,
  runAgent
};
