export const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function parseRetryAfterMs(headerVal: string | null | undefined): number | null {
  if (!headerVal) return null;
  const seconds = Number(headerVal.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.round(seconds * 1000), 30_000);
  }
  return null;
}

export function computeBackoffDelayMs(
  attempt: number,
  baseDelayMs: number,
  retryAfterHeader?: string | null,
): number {
  const retryAfterMs = parseRetryAfterMs(retryAfterHeader);
  if (retryAfterMs !== null) return retryAfterMs;
  const jitter = 0.8 + Math.random() * 0.4;
  return Math.round(baseDelayMs * Math.pow(2, attempt - 1) * jitter);
}
