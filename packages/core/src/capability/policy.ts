import type {
  AgentSpec,
  CapabilityPolicy,
  SandboxSpec,
} from "@agentic-action/contracts";

export const BASE_SAFE_ENV_KEYS = [
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
  "MODELS_DEV_URL",
] as const;

export const FIXED_CHILD_ENV: Readonly<Record<string, string>> = {
  CI: "true",
  GIT_PAGER: "cat",
  PAGER: "cat",
  GH_PROMPT_DISABLED: "1",
};

const PROVIDER_ENV_MAP: Readonly<Record<string, readonly string[]>> = {
  "half-cabbage": ["HALF_CABBAGE_API_KEY", "HALF_CABBAGE_KEY", "HALF_CABBAGE_BASE_URL"],
  openai: ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
  anthropic: [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_OAUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
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
    "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
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
    "AWS_REGION",
  ],
  xai: ["XAI_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  fireworks: ["FIREWORKS_API_KEY"],
  together: ["TOGETHER_API_KEY"],
  baseten: ["BASETEN_API_KEY"],
  huggingface: ["HF_TOKEN"],
  radius: ["RADIUS_API_KEY"],
};

export function inferProvider(provider?: string, model?: string): string {
  const explicit = (provider ?? "").trim().toLowerCase();
  if (explicit) return explicit;

  const rawModel = (model ?? "").trim().toLowerCase();
  if (!rawModel) return "";

  if (rawModel.includes("/")) {
    const prefix = rawModel.split("/")[0]?.trim() ?? "";
    if (prefix) return prefix;
  }

  if (
    rawModel.startsWith("gpt-") ||
    rawModel.startsWith("o1") ||
    rawModel.startsWith("o3") ||
    rawModel.startsWith("o4") ||
    rawModel.startsWith("chatgpt-")
  ) {
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

export function resolveProviderEnvKeys(provider?: string, model?: string): string[] {
  const inferred = inferProvider(provider, model);
  if (!inferred) return [];
  const keys = PROVIDER_ENV_MAP[inferred];
  return keys ? [...keys] : [];
}

export function hasModelCredentials(
  params: {
    apiKey?: string;
    provider?: string;
    model?: string;
    envAllow?: readonly string[];
  },
  hostEnv: Readonly<Record<string, string | undefined>>,
): boolean {
  if (params.apiKey && params.apiKey.trim()) return true;

  const providerKeys = resolveProviderEnvKeys(params.provider, params.model);
  const candidates = new Set<string>([
    ...providerKeys,
    ...(params.envAllow ?? []),
  ]);

  if (candidates.size > 0) {
    for (const key of candidates) {
      if (hostEnv[key] && String(hostEnv[key]).trim()) {
        return true;
      }
    }
    return false;
  }

  // Fallback when neither provider nor recognizable model prefix is given:
  // check known LLM provider keys (excluding TYPESAFE_API_KEY / GITHUB_TOKEN).
  for (const keyList of Object.values(PROVIDER_ENV_MAP)) {
    for (const key of keyList) {
      if (key.endsWith("_BASE_URL") || key.endsWith("_ACCOUNT_ID") || key.endsWith("_REGION")) {
        continue;
      }
      if (hostEnv[key] && String(hostEnv[key]).trim()) {
        return true;
      }
    }
  }
  return false;
}

export function isShellEnabledInPolicy(policy: CapabilityPolicy): boolean {
  if (policy.noTools || policy.noBuiltinTools) return false;

  const excluded = new Set(
    (policy.excludeTools ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean),
  );
  if (excluded.has("bash") && excluded.has("powershell")) {
    return false;
  }

  if (policy.tools.length > 0) {
    const allowed = policy.tools.map((t) => t.trim().toLowerCase()).filter(Boolean);
    return allowed.some(
      (name) =>
        (name === "*" || name === "bash" || name === "powershell") &&
        !excluded.has(name === "*" ? "bash" : name),
    );
  }

  return !excluded.has("bash");
}

export function deriveCapabilityPolicy(inputs: {
  tools?: string | readonly string[];
  excludeTools?: string | readonly string[];
  noBuiltinTools?: boolean | string;
  noTools?: boolean | string;
  provider?: string;
  model?: string;
  envAllow?: string | readonly string[];
  trustProject?: boolean;
  allowMcp?: boolean;
}): CapabilityPolicy {
  const splitCsv = (val?: string | readonly string[]): string[] => {
    if (!val) return [];
    if (Array.isArray(val)) {
      return val.map((s) => String(s).trim()).filter(Boolean);
    }
    return String(val)
      .split(",")
      .map((s) => s.trim().replace(/^[+-]/, ""))
      .filter(Boolean);
  };

  const noTools = inputs.noTools === true || inputs.noTools === "true";
  const noBuiltinTools =
    inputs.noBuiltinTools === true || inputs.noBuiltinTools === "true";
  const tools = noTools ? [] : splitCsv(inputs.tools);
  const excludeTools = splitCsv(inputs.excludeTools);

  const providerEnv = resolveProviderEnvKeys(inputs.provider, inputs.model);
  const explicitEnvAllow = splitCsv(inputs.envAllow);
  const envAllow = [...new Set([...providerEnv, ...explicitEnvAllow])];

  return {
    tools,
    excludeTools,
    noBuiltinTools,
    noTools,
    envAllow,
    trustProject: inputs.trustProject ?? false,
    allowMcp: inputs.allowMcp ?? false,
  };
}

export function buildSandboxSpec(
  spec: AgentSpec,
  hostEnv: Readonly<Record<string, string | undefined>>,
  options: { githubToken?: string } = {},
): SandboxSpec {
  const prompt = (spec.prompt ?? "").trim();
  if (!prompt) {
    throw new Error("缺少有效的 prompt（不能为空）");
  }

  const { policy } = spec;
  const trustFlag = policy.trustProject ? "--approve" : "--no-approve";
  const argv: string[] = ["-p", trustFlag];
  const redactedArgv: string[] = ["-p", trustFlag];

  if (!policy.allowMcp) {
    argv.push("--no-mcp");
    redactedArgv.push("--no-mcp");
  }

  const pushFlag = (flag: string, val: string | undefined, secret = false) => {
    if (val === undefined || val === null || val === "") return;
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

  // Construct strict allowlist child environment
  const env: Record<string, string> = { ...FIXED_CHILD_ENV };
  const allowedKeys = new Set<string>([
    ...BASE_SAFE_ENV_KEYS,
    ...policy.envAllow,
  ]);

  for (const key of allowedKeys) {
    // Never pass INPUT_*, GITHUB_TOKEN, GH_TOKEN, or TYPESAFE_API_KEY via generic allowlist
    // unless explicitly requested in policy.envAllow (and still never INPUT_*).
    if (key.startsWith("INPUT_")) continue;
    if (key === "GITHUB_TOKEN" || key === "GH_TOKEN") continue;
    const val = hostEnv[key];
    if (typeof val === "string" && val.length > 0) {
      env[key] = val;
    }
  }

  if (isShellEnabledInPolicy(policy)) {
    const token =
      options.githubToken || hostEnv.GH_TOKEN || hostEnv.GITHUB_TOKEN;
    if (token && token.trim()) {
      env.GH_TOKEN = token.trim();
    }
  }

  return { argv, env, redactedArgv };
}

export function collectSensitiveValues(
  hostEnv: Readonly<Record<string, string | undefined>>,
  extraSecrets: readonly (string | undefined)[] = [],
): string[] {
  const values = new Set<string>();

  const addIfSecret = (val: string | undefined) => {
    if (!val) return;
    const trimmed = val.trim();
    if (trimmed.length >= 8) {
      values.add(trimmed);
    }
  };

  for (const [key, val] of Object.entries(hostEnv)) {
    if (!val) continue;
    if (
      /(?:_KEY|_TOKEN|_SECRET|PASSWORD|AUTHORIZATION)$/i.test(key) ||
      /^INPUT_(?:API_KEY|GITHUB_TOKEN|TYPESAFE_API_KEY)$/i.test(key)
    ) {
      addIfSecret(val);
    }
  }

  for (const extra of extraSecrets) {
    addIfSecret(extra);
  }

  // Sort longest first so substring replacement never leaves partial suffix
  return [...values].sort((a, b) => b.length - a.length);
}

export function redactText(
  text: string,
  secretValues: readonly string[] = [],
): string {
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
    "$1***",
  );
  out = out.replace(
    /\b([A-Za-z0-9_]*(?:_KEY|_TOKEN|_SECRET)=)([^\s"']+)/g,
    "$1***",
  );
  out = out.replace(/\b(gh[pousr]_[A-Za-z0-9_]{8,})\b/g, "***");

  return out;
}

/**
 * Test whether a relative path tries to escape outside its root directory,
 * or is an absolute/drive-rooted path.
 */
export function isPathEscaping(rel: string): boolean {
  if (!rel) return false;
  const norm = rel.split("\\").join("/");
  if (norm.startsWith("/") || /^[a-zA-Z]:[/\\]/.test(norm)) return true;
  const segments = norm.split("/").filter(Boolean);
  let depth = 0;
  for (const seg of segments) {
    if (seg === "..") {
      depth--;
      if (depth < 0) return true;
    } else if (seg !== ".") {
      depth++;
    }
  }
  return depth < 0;
}

