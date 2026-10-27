import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  redacted?: boolean;
}

interface Usage {
  input?: number;
  output?: number;
  cacheRead?: number;
  reasoning?: number;
  totalTokens?: number;
  cost?: { total?: number };
}

interface AssistantLikeMessage {
  role: "assistant";
  provider?: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  usage?: Usage;
  content?: ContentBlock[];
}

interface ToolResultBlock {
  type?: string;
  text?: string;
}

const MAX_INLINE_VALUE_CHARS = 120;
const MAX_ERROR_PREVIEW_CHARS = 300;

function isEnabled(ctx: ExtensionContext): boolean {
  if (process.env.PI_CI_LOG === "0" || process.env.PI_CI_LOG === "false") {
    return false;
  }
  if (process.env.PI_CI_LOG === "1" || process.env.PI_CI_LOG === "true") {
    return true;
  }
  const mode = (ctx as { mode?: string }).mode;
  return mode !== "tui" && !ctx.hasUI;
}

function isGitHubActions(): boolean {
  return process.env.GITHUB_ACTIONS === "true" || process.env.CI === "true";
}

function writeLine(text: string): void {
  process.stderr.write(`${text}\n`);
}

function writeGroup(title: string, body: string): void {
  const trimmed = body.trim();
  if (!trimmed) return;
  if (isGitHubActions()) {
    writeLine(`::group::${title}`);
    writeLine(trimmed);
    writeLine("::endgroup::");
  } else {
    writeLine(`--- ${title} ---`);
    writeLine(trimmed);
    writeLine("---");
  }
}

function singleLine(text: string, max = MAX_INLINE_VALUE_CHARS): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 3)}...`;
}

function formatArgsSummary(toolName: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;

  if (toolName === "read" && typeof record.path === "string") {
    const range: string[] = [];
    if (record.offset !== undefined) range.push(`offset=${record.offset}`);
    if (record.limit !== undefined) range.push(`limit=${record.limit}`);
    return range.length > 0 ? `${record.path} (${range.join(", ")})` : record.path;
  }

  if ((toolName === "write" || toolName === "edit") && typeof record.path === "string") {
    return record.path;
  }

  if (toolName === "bash" && typeof record.command === "string") {
    return singleLine(record.command);
  }

  if (toolName === "grep" && typeof record.pattern === "string") {
    const scope = typeof record.path === "string" ? ` in ${record.path}` : "";
    return `${singleLine(record.pattern, 80)}${scope}`;
  }

  if ((toolName === "find" || toolName === "ls") && typeof record.path === "string") {
    const pattern = typeof record.pattern === "string" ? ` (${record.pattern})` : "";
    return `${record.path}${pattern}`;
  }

  const pairs: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || value === null || value === "") continue;
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    pairs.push(`${key}=${singleLine(raw, 60)}`);
    if (pairs.length >= 3) break;
  }
  return pairs.join(" ");
}

function formatUsage(usage: Usage | undefined): string {
  if (!usage) return "";
  const parts: string[] = [];
  if (typeof usage.input === "number" && usage.input > 0) parts.push(`in=${usage.input}`);
  if (typeof usage.output === "number" && usage.output > 0) parts.push(`out=${usage.output}`);
  if (typeof usage.cacheRead === "number" && usage.cacheRead > 0) parts.push(`cache=${usage.cacheRead}`);
  if (typeof usage.reasoning === "number" && usage.reasoning > 0) parts.push(`reasoning=${usage.reasoning}`);
  if (typeof usage.cost?.total === "number" && usage.cost.total > 0) {
    parts.push(`cost=$${usage.cost.total.toFixed(4)}`);
  }
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

function extractToolErrorPreview(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const content = (result as { content?: ToolResultBlock[] }).content;
  if (!Array.isArray(content)) return "";
  const text = content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join(" ");
  return text ? `: ${singleLine(text, MAX_ERROR_PREVIEW_CHARS)}` : "";
}

export default function ciLoggerExtension(pi: ExtensionAPI): void {
  let turnCount = 0;
  const toolArgsByCallId = new Map<string, string>();

  pi.on("turn_start", (_event, ctx) => {
    if (!isEnabled(ctx)) return;
    turnCount += 1;
  });

  pi.on("message_end", (event, ctx) => {
    if (!isEnabled(ctx)) return;
    const msg = event.message as unknown as AssistantLikeMessage;
    if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) return;

    const thinkingBlocks = msg.content
      .filter((block) => block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim())
      .map((block) => (block.thinking as string).trim());

    if (thinkingBlocks.length > 0) {
      const fullThinking = thinkingBlocks.join("\n\n");
      writeGroup(`[Turn ${turnCount}] Thinking (${fullThinking.length} chars)`, fullThinking);
    }

    const textBlocks = msg.content
      .filter((block) => block?.type === "text" && typeof block.text === "string" && block.text.trim())
      .map((block) => (block.text as string).trim());

    const hasToolCalls = msg.content.some((block) => block?.type === "toolCall");
    if (textBlocks.length > 0 && hasToolCalls) {
      writeLine(`[Turn ${turnCount}] ${textBlocks.join("\n")}`);
    }

    if (msg.stopReason === "error" || msg.stopReason === "aborted") {
      const detail = msg.errorMessage ? `: ${msg.errorMessage}` : "";
      writeLine(`[Turn ${turnCount}] Model stopped (${msg.stopReason})${detail}`);
    }
  });

  pi.on("tool_execution_start", (event, ctx) => {
    if (!isEnabled(ctx)) return;
    const summary = formatArgsSummary(event.toolName, event.args);
    if (event.toolCallId) {
      toolArgsByCallId.set(event.toolCallId, summary);
    }
    const label = summary ? `${event.toolName} ${summary}` : event.toolName;
    writeLine(`[Turn ${turnCount}] -> ${label}`);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (!isEnabled(ctx)) return;
    const summary = (event.toolCallId ? toolArgsByCallId.get(event.toolCallId) : undefined) ?? "";
    if (event.toolCallId) {
      toolArgsByCallId.delete(event.toolCallId);
    }
    const duration = typeof event.durationMs === "number" ? ` (${Math.round(event.durationMs)}ms)` : "";
    const status = event.isError ? "ERROR" : "OK";
    const errorPreview = event.isError ? extractToolErrorPreview(event.result) : "";
    const target = summary ? `${event.toolName} ${summary}` : event.toolName;
    writeLine(`[Turn ${turnCount}] <- ${target} [${status}]${duration}${errorPreview}`);
  });

  pi.on("turn_end", (event, ctx) => {
    if (!isEnabled(ctx)) return;
    const msg = event.message as unknown as AssistantLikeMessage | undefined;
    if (!msg || msg.role !== "assistant") return;
    const usage = formatUsage(msg.usage);
    if (usage) {
      writeLine(`[Turn ${turnCount}] Completed${usage}`);
    }
  });
}
