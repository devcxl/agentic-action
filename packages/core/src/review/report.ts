import { Value } from "@sinclair/typebox/value";
import {
  CATEGORIES,
  SEVERITY_ORDER,
  SubmitReviewInputSchema,
  VERDICTS,
  type Category,
  type ChunkReport,
  type Finding,
  type ReviewReport,
  type Severity,
  type SubmitReviewInput,
  type Verdict,
} from "@agentic-action/contracts";

export function normalizeFinding(item: unknown, index = 0): Finding {
  const obj = (item && typeof item === "object" ? item : {}) as Record<
    string,
    unknown
  >;
  const rawSeverity = String(obj.severity ?? "medium").toLowerCase();
  const severity: Severity = (SEVERITY_ORDER as readonly string[]).includes(
    rawSeverity,
  )
    ? (rawSeverity as Severity)
    : "medium";

  const rawCategory = String(obj.category ?? "other").toLowerCase();
  const category: Category = (CATEGORIES as readonly string[]).includes(
    rawCategory,
  )
    ? (rawCategory as Category)
    : "other";

  const lineNum = Number(obj.line);
  return {
    file: String(obj.file ?? "(unknown)").trim() || "(unknown)",
    line: Number.isFinite(lineNum) && lineNum >= 0 ? Math.floor(lineNum) : 0,
    severity,
    category,
    title: String(obj.title ?? `未命名问题 #${index + 1}`).trim() || `未命名问题 #${index + 1}`,
    detail: String(obj.detail ?? "").trim(),
    suggestion: String(obj.suggestion ?? "").trim(),
  };
}

/**
 * Validate structured `submit_review` tool arguments against TypeBox schema.
 */
export function validateSubmitReviewInput(raw: unknown): SubmitReviewInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("submit_review 参数必须是对象");
  }
  const obj = raw as Record<string, unknown>;
  const normalizedCandidate: SubmitReviewInput = {
    summary: typeof obj.summary === "string" ? obj.summary.trim() : "",
    verdict:
      obj.verdict === "approve" ||
      obj.verdict === "comment" ||
      obj.verdict === "request_changes"
        ? obj.verdict
        : ("invalid" as "comment"),
    findings: Array.isArray(obj.findings)
      ? obj.findings.map((f, idx) => normalizeFinding(f, idx))
      : ("invalid" as unknown as Finding[]),
    ...(obj.files_reviewed !== undefined
      ? { files_reviewed: Number(obj.files_reviewed) }
      : {}),
    ...(typeof obj.notes === "string" ? { notes: obj.notes } : {}),
  };

  if (!Value.Check(SubmitReviewInputSchema, normalizedCandidate)) {
    const errors = [...Value.Errors(SubmitReviewInputSchema, normalizedCandidate)]
      .map((e) => `${e.path}: ${e.message}`)
      .join("; ");
    throw new Error(`submit_review schema 校验失败: ${errors}`);
  }
  return normalizedCandidate;
}

export function toChunkReport(
  chunkIndex: number,
  input: SubmitReviewInput,
  defaultFilesCount: number,
): ChunkReport {
  return {
    chunkIndex,
    summary: input.summary,
    verdict: input.verdict,
    findings: input.findings,
    filesReviewed: input.files_reviewed ?? defaultFilesCount,
    notes: input.notes,
  };
}

/**
 * Legacy / fallback JSON extractor for plain-text outputs or tests.
 */
export function extractJsonReport(rawText: string): Record<string, unknown> {
  const trimmed = String(rawText ?? "").trim();
  if (!trimmed) throw new Error("报告内容为空");

  const isReportShape = (obj: unknown): obj is Record<string, unknown> =>
    Boolean(
      obj &&
        typeof obj === "object" &&
        !Array.isArray(obj) &&
        (Array.isArray((obj as Record<string, unknown>).findings) ||
          typeof (obj as Record<string, unknown>).summary === "string" ||
          typeof (obj as Record<string, unknown>).verdict === "string"),
    );

  try {
    const direct = JSON.parse(trimmed);
    if (direct && typeof direct === "object" && !Array.isArray(direct)) {
      return direct as Record<string, unknown>;
    }
  } catch {
    // continue
  }

  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  const candidates: Record<string, unknown>[] = [];
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(trimmed)) !== null) {
    try {
      const parsed = JSON.parse((match[1] ?? "").trim());
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        candidates.push(parsed as Record<string, unknown>);
      }
    } catch {
      // ignore
    }
  }
  for (let i = candidates.length - 1; i >= 0; i--) {
    if (isReportShape(candidates[i])) return candidates[i]!;
  }
  if (candidates.length > 0) return candidates[candidates.length - 1]!;

  const braceBlocks: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        braceBlocks.push(trimmed.slice(start, i + 1));
        start = -1;
      } else if (depth < 0) {
        depth = 0;
        start = -1;
      }
    }
  }

  for (let i = braceBlocks.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(braceBlocks[i]!);
      if (isReportShape(parsed)) return parsed;
    } catch {
      // ignore
    }
  }

  throw new Error("无法从输出中解析有效的 JSON 审查报告");
}

export function normalizeReport(raw: unknown): ReviewReport {
  const report =
    typeof raw === "string"
      ? extractJsonReport(raw)
      : (raw as Record<string, unknown>);
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new Error("report 必须是 JSON 对象");
  }

  const findingsRaw = Array.isArray(report.findings) ? report.findings : [];
  const findings = findingsRaw.map((item, idx) => normalizeFinding(item, idx));

  const rawVerdict = String(report.verdict ?? "comment");
  const verdict: Verdict = (VERDICTS as readonly string[]).includes(rawVerdict)
    ? (rawVerdict as Verdict)
    : "comment";

  const cov =
    report.coverage && typeof report.coverage === "object"
      ? (report.coverage as Record<string, unknown>)
      : {};

  const chunksReviewed = Array.isArray(cov.chunks_reviewed)
    ? cov.chunks_reviewed.map((n) => Number(n)).filter((n) => Number.isFinite(n))
    : [];
  const chunksTotal = Number.isFinite(Number(cov.chunks_total))
    ? Number(cov.chunks_total)
    : chunksReviewed.length;
  const chunksPlanned = Number.isFinite(Number(cov.chunks_planned))
    ? Number(cov.chunks_planned)
    : chunksTotal;
  const filesReviewed = Number.isFinite(Number(cov.files_reviewed))
    ? Number(cov.files_reviewed)
    : 0;
  const filesTotal = Number.isFinite(Number(cov.files_total))
    ? Number(cov.files_total)
    : filesReviewed;

  const plannedRatio =
    typeof cov.planned === "number"
      ? cov.planned
      : chunksPlanned > 0
      ? chunksReviewed.length / chunksPlanned
      : 1;
  const totalRatio =
    typeof cov.total === "number"
      ? cov.total
      : chunksTotal > 0
      ? chunksReviewed.length / chunksTotal
      : 1;

  return {
    summary: typeof report.summary === "string" ? report.summary.trim() : "",
    verdict,
    coverage: {
      planned: Number(plannedRatio.toFixed(4)),
      total: Number(totalRatio.toFixed(4)),
      chunks_reviewed: chunksReviewed,
      chunks_planned: chunksPlanned,
      chunks_total: chunksTotal,
      files_reviewed: filesReviewed,
      files_total: filesTotal,
      ...(typeof cov.notes === "string" && cov.notes.trim()
        ? { notes: cov.notes.trim() }
        : {}),
    },
    findings,
  };
}
