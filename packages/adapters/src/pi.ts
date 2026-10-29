import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { AgentUsage, SandboxSpec } from "@agentic-action/contracts";
import { computeBackoffDelayMs, defaultSleep } from "./retry.ts";

export interface PiStreamResult {
  exitCode: number;
  stdout: string;
  textOutput: string;
  toolSubmissions: Record<string, unknown[]>;
  usage: AgentUsage;
  settled: boolean;
  aborted: boolean;
  timedOut: boolean;
  corruptedLines: number;
  transientError?: string;
  errorMessage?: string;
}

/**
 * Split UTF-8 chunk buffer strictly on LF (`\n`), stripping an optional preceding CR (`\r`).
 * Never splits on Unicode line/paragraph separators (U+2028 / U+2029).
 */
export function splitLfLines(buffer: string): {
  lines: string[];
  remainder: string;
} {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer.charCodeAt(i) === 0x0a) {
      const end =
        i > start && buffer.charCodeAt(i - 1) === 0x0d ? i - 1 : i;
      lines.push(buffer.slice(start, end));
      start = i + 1;
    }
  }
  return {
    lines,
    remainder: buffer.slice(start),
  };
}

export function createEmptyUsage(): AgentUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    costTotal: 0,
  };
}

function accumulateUsage(target: AgentUsage, rawUsage: unknown): void {
  if (!rawUsage || typeof rawUsage !== "object") return;
  const u = rawUsage as Record<string, unknown>;
  const addNum = (val: unknown): number =>
    typeof val === "number" && Number.isFinite(val) && val > 0 ? val : 0;

  target.inputTokens += addNum(u.input);
  target.outputTokens += addNum(u.output);
  target.cacheReadTokens += addNum(u.cacheRead);
  target.cacheWriteTokens += addNum(u.cacheWrite);
  target.reasoningTokens += addNum(u.reasoning);
  target.totalTokens += addNum(u.totalTokens);

  if (u.cost && typeof u.cost === "object") {
    const costObj = u.cost as Record<string, unknown>;
    target.costTotal = Number(
      (target.costTotal + addNum(costObj.total)).toFixed(6),
    );
  }
}

function isTransientErrorMessage(msg?: string): boolean {
  if (!msg) return false;
  return /\b(429|500|502|503|504|529)\b|overloaded|rate[_\s-]?limit|timeout|timed?\s*out|econnreset|etimedout|socket hang up/i.test(
    msg,
  );
}

export interface RunPiOptions {
  piBin?: string;
  cwd?: string;
  mode?: "text" | "json";
  timeoutMs?: number;
  signal?: AbortSignal;
  streamToStdout?: boolean;
}

export async function runPiSubprocess(
  sandbox: SandboxSpec,
  options: RunPiOptions = {},
): Promise<PiStreamResult> {
  const piBin = options.piBin || "pi";
  const cwd = options.cwd ?? process.cwd();
  const mode = options.mode ?? (sandbox.argv.includes("json") ? "json" : "text");
  const streamToStdout = options.streamToStdout ?? mode === "text";

  const usage = createEmptyUsage();
  const toolSubmissions: Record<string, unknown[]> = {};
  const recordedToolCallIds = new Set<string>();
  const textBlocks: string[] = [];
  const rawChunks: Buffer[] = [];

  let settled = false;
  let aborted = false;
  let timedOut = false;
  let corruptedLines = 0;
  let transientError: string | undefined;
  let errorMessage: string | undefined;
  let lineRemainder = "";
  const decoder = new StringDecoder("utf8");

  const recordToolPayload = (
    toolName: string,
    payload: unknown,
    callId?: string,
  ) => {
    if (!toolName || payload === undefined || payload === null) return;
    if (callId) {
      if (recordedToolCallIds.has(callId)) return;
      recordedToolCallIds.add(callId);
    }
    if (!toolSubmissions[toolName]) {
      toolSubmissions[toolName] = [];
    }
    toolSubmissions[toolName]!.push(payload);
  };

  const handleAssistantMessage = (
    msg: Record<string, unknown>,
    countUsage: boolean,
  ) => {
    if (msg.role !== "assistant") return;
    if (countUsage) {
      accumulateUsage(usage, msg.usage);
    }
    if (msg.stopReason === "error" || msg.stopReason === "aborted") {
      if (msg.stopReason === "aborted") aborted = true;
      const errText =
        typeof msg.errorMessage === "string" ? msg.errorMessage : "";
      if (errText) {
        errorMessage = errText;
        if (
          isTransientErrorMessage(errText) ||
          (usage.totalTokens > 0 &&
            /invalid 'authorization' header or token/i.test(errText))
        ) {
          transientError = errText;
        }
      }
    }

    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          textBlocks.push(b.text);
        } else if (
          b.type === "toolCall" &&
          typeof b.name === "string" &&
          b.arguments &&
          typeof b.arguments === "object"
        ) {
          // Record toolCall arguments if tool_execution_end doesn't overwrite it later;
          // we use a fallback map keyed by callId if needed.
          const callId = typeof b.id === "string" ? `arg:${b.id}` : undefined;
          recordToolPayload(b.name, b.arguments, callId);
        }
      }
    }
  };

  const processJsonLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        corruptedLines += 1;
        return;
      }
      event = parsed as Record<string, unknown>;
    } catch {
      corruptedLines += 1;
      return;
    }

    const type = event.type;
    if (type === "tool_execution_end") {
      const toolName =
        typeof event.toolName === "string" ? event.toolName : "";
      const isErr = event.isError === true;
      const callId =
        typeof event.toolCallId === "string" ? event.toolCallId : undefined;
      if (!isErr && toolName && event.result && typeof event.result === "object") {
        const resObj = event.result as Record<string, unknown>;
        const payload = resObj.details ?? resObj.structuredContent;
        if (payload !== undefined) {
          recordToolPayload(toolName, payload, callId);
        }
      }
    } else if (type === "turn_end") {
      if (event.message && typeof event.message === "object") {
        handleAssistantMessage(
          event.message as Record<string, unknown>,
          true,
        );
      }
      if (Array.isArray(event.toolResults)) {
        for (const tr of event.toolResults) {
          if (!tr || typeof tr !== "object") continue;
          const trObj = tr as Record<string, unknown>;
          const toolName =
            typeof trObj.toolName === "string" ? trObj.toolName : "";
          const callId =
            typeof trObj.toolCallId === "string" ? trObj.toolCallId : undefined;
          if (trObj.isError !== true && toolName) {
            const payload = trObj.details ?? trObj.structuredContent;
            if (payload !== undefined) {
              recordToolPayload(toolName, payload, callId);
            }
          }
        }
      }
    } else if (type === "message_end") {
      // Only extract text/toolCalls if turn_end hasn't already counted it
      if (event.message && typeof event.message === "object") {
        const msg = event.message as Record<string, unknown>;
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

  const exitCode = await new Promise<number>((resolveExit, reject) => {
    const child = spawn(piBin, sandbox.argv, {
      cwd,
      env: sandbox.env,
      stdio: ["ignore", "pipe", "inherit"],
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

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
        }, 2000);
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

    child.stdout.on("data", (chunk: Buffer) => {
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
      resolveExit(timedOut ? 124 : (code ?? 1));
    });
  });

  const fullStdout = Buffer.concat(rawChunks).toString("utf8");
  const textOutput =
    mode === "json" && textBlocks.length > 0
      ? textBlocks.join("\n")
      : fullStdout;

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
    ...(transientError ? { transientError } : {}),
    ...(errorMessage ? { errorMessage } : {}),
  };
}

export async function runPiWithRetry(
  sandbox: SandboxSpec,
  options: RunPiOptions & {
    maxRetries?: number;
    baseDelayMs?: number;
    requiredTool?: string;
    sleepImpl?: (ms: number) => Promise<void>;
  } = {},
): Promise<{ result: PiStreamResult; attempts: number; durationsMs: number[] }> {
  const maxRetries = options.maxRetries ?? 2;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const sleep = options.sleepImpl ?? defaultSleep;

  const durationsMs: number[] = [];
  let lastResult!: PiStreamResult;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const start = Date.now();
    lastResult = await runPiSubprocess(sandbox, options);
    durationsMs.push(Date.now() - start);

    const hasToolOutput = options.requiredTool
      ? (lastResult.toolSubmissions[options.requiredTool]?.length ?? 0) > 0
      : true;

    if (lastResult.exitCode === 0 && hasToolOutput) {
      return { result: lastResult, attempts: attempt, durationsMs };
    }

    const isMissingRequiredTool = Boolean(
      options.requiredTool &&
        lastResult.exitCode === 0 &&
        !lastResult.aborted &&
        !lastResult.errorMessage,
    );
    // Missing requiredTool retry is capped at 1 retry (attempt <= 1) to avoid 4x LLM costs
    const isRetryable =
      !options.signal?.aborted &&
      !hasToolOutput &&
      (lastResult.timedOut ||
        Boolean(lastResult.transientError) ||
        (isMissingRequiredTool && attempt <= 1));

    if (!isRetryable || attempt > maxRetries) {
      return { result: lastResult, attempts: attempt, durationsMs };
    }

    await sleep(computeBackoffDelayMs(attempt, baseDelayMs));
  }

  return {
    result: lastResult,
    attempts: durationsMs.length,
    durationsMs,
  };
}
