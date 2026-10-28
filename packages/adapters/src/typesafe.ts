import type {
  JevSystemOneRequest,
  JevSystemOneResponse,
} from "@agentic-action/contracts";
import { computeBackoffDelayMs, defaultSleep } from "./retry.ts";

export class TypeSafeError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.name = "TypeSafeError";
    this.status = status;
    this.retryable = retryable;
  }
}

export interface CallSystemOneOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  longContext?: boolean;
  sleepImpl?: (ms: number) => Promise<void>;
}

/**
 * Call TypeSafe System One endpoint `POST /v1/systemone` with bounded exponential backoff
 * on 429 / 529 / 5xx / timeout (per `docs/triage-design.md` §2 & §6.2).
 */
export async function callSystemOne(
  request: JevSystemOneRequest,
  options: CallSystemOneOptions,
): Promise<JevSystemOneResponse> {
  const apiKey = (options.apiKey ?? "").trim();
  if (!apiKey) {
    throw new TypeSafeError("缺少 TYPESAFE_API_KEY", 401, false);
  }

  const baseUrl = (options.baseUrl || "https://api.typesafe.ai").replace(
    /\/+$/,
    "",
  );
  const url = `${baseUrl}/v1/systemone`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 300;
  const sleep = options.sleepImpl ?? defaultSleep;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (options.longContext) {
    headers["TypeSafe-Danger-Zone-Long-Context"] = "true";
  }

  const bodyStr = JSON.stringify(request);
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers,
        body: bodyStr,
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.ok) {
        let json: unknown;
        try {
          json = await res.json();
        } catch {
          throw new TypeSafeError(
            "TypeSafe 响应不是合法的 JSON",
            res.status,
            false,
          );
        }
        if (!json || typeof json !== "object" || Array.isArray(json)) {
          throw new TypeSafeError(
            "TypeSafe 响应顶层必须是 JSON 对象",
            res.status,
            false,
          );
        }
        return json as JevSystemOneResponse;
      }

      const status = res.status;
      const errBody = await res.text().catch(() => "");
      const retryable =
        status === 429 || status === 529 || (status >= 500 && status <= 599);

      if (!retryable || attempt > maxRetries) {
        throw new TypeSafeError(
          `TypeSafe API 请求失败 (HTTP ${status}): ${errBody.slice(0, 300)}`,
          status,
          retryable,
        );
      }

      const retryAfterHeader =
        typeof res.headers?.get === "function"
          ? res.headers.get("retry-after")
          : null;
      await sleep(computeBackoffDelayMs(attempt, baseDelayMs, retryAfterHeader));
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof TypeSafeError && !err.retryable) {
        throw err;
      }
      if (err instanceof TypeSafeError && attempt > maxRetries) {
        throw err;
      }

      const isAbort =
        err instanceof Error &&
        (err.name === "AbortError" || /aborted|timeout/i.test(err.message));
      lastError = isAbort
        ? new TypeSafeError(
            `TypeSafe API 请求超时 (${timeoutMs}ms)`,
            504,
            true,
          )
        : err instanceof Error
        ? err
        : new Error(String(err));

      if (attempt > maxRetries) {
        throw lastError;
      }

      await sleep(computeBackoffDelayMs(attempt, baseDelayMs));
    }
  }

  throw lastError ?? new TypeSafeError("TypeSafe API 请求失败", 500, true);
}
