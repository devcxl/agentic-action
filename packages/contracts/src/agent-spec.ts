export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface CapabilityPolicy {
  /** Exact tool allowlist passed to `--tools`. Empty array when `noTools` is true. */
  tools: string[];
  /** Explicit environment variable names allowed into the Pi child process. */
  envAllow: string[];
  /** Maps to `--approve` (true) or `--no-approve` (false). Always false for PR review. */
  trustProject: boolean;
  /** Maps to `--no-mcp` when false. Always false for PR review. */
  allowMcp: boolean;
  /** Maps to `--no-tools` when true. */
  noTools?: boolean;
  /** Maps to `--no-builtin-tools` when true. */
  noBuiltinTools?: boolean;
  /** Maps to `--exclude-tools` when non-empty. */
  excludeTools?: string[];
}

export interface SandboxSpec {
  argv: string[];
  env: Record<string, string>;
  redactedArgv: string[];
}

export interface AgentSpec {
  prompt: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  contextFiles?: string[];
  promptTemplate?: string;
  model: string;
  provider?: string;
  thinking?: ThinkingLevel | "";
  apiKey?: string;
  mode?: "text" | "json";
  policy: CapabilityPolicy;
  extensions?: string[];
  timeoutMs?: number;
}
