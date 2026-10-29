import { redactText } from "@agentic-action/core";

function redact(
  text: string,
  secretValues: readonly string[] = [],
): string {
  return redactText(text, secretValues);
}

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(
  scope: string,
  secretValues: readonly string[] = [],
  writer: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Logger {
  const formatLine = (
    level: string,
    msg: string,
    fields?: Record<string, unknown>,
  ): string => {
    const kvParts: string[] = [`level=${level}`, `scope=${scope}`];
    if (fields) {
      for (const [k, v] of Object.entries(fields)) {
        if (v === undefined) continue;
        const serialized =
          typeof v === "string" ? v : JSON.stringify(v);
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
    },
  };
}
