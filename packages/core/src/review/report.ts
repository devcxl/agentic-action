import {
  CATEGORIES,
  SEVERITY_ORDER,
  type Category,
  type ChunkReport,
  type Finding,
  type Severity,
  type SubmitReviewInput,
} from "@agentic-action/contracts";

function normalizeFinding(item: unknown, index = 0): Finding {
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
    title:
      String(obj.title ?? `未命名问题 #${index + 1}`).trim() ||
      `未命名问题 #${index + 1}`,
    detail: String(obj.detail ?? "").trim(),
    suggestion: String(obj.suggestion ?? "").trim(),
  };
}

/**
 * Validate structured `submit_review` tool arguments.
 */
export function validateSubmitReviewInput(raw: unknown): SubmitReviewInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("submit_review 参数必须是对象");
  }
  const obj = raw as Record<string, unknown>;
  const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
  if (!summary) {
    throw new Error("submit_review schema 校验失败: summary 不能为空");
  }

  const rawVerdict =
    typeof obj.verdict === "string" ? obj.verdict.trim().toLowerCase() : "";
  if (
    rawVerdict !== "approve" &&
    rawVerdict !== "comment" &&
    rawVerdict !== "request_changes"
  ) {
    throw new Error(
      `submit_review schema 校验失败: verdict 必须为 approve|comment|request_changes，实际为 ${String(obj.verdict)}`,
    );
  }
  const verdict: SubmitReviewInput["verdict"] = rawVerdict;

  if (!Array.isArray(obj.findings)) {
    throw new Error("submit_review schema 校验失败: findings 必须是数组");
  }

  const findings = obj.findings.map((f, idx) => normalizeFinding(f, idx));

  let filesReviewed: number | undefined;
  if (obj.files_reviewed !== undefined) {
    const num = Number(obj.files_reviewed);
    if (!Number.isFinite(num) || num < 0) {
      throw new Error(
        `submit_review schema 校验失败: files_reviewed 必须是非负数字`,
      );
    }
    filesReviewed = Math.floor(num);
  }

  return {
    summary,
    verdict,
    findings,
    ...(filesReviewed !== undefined ? { files_reviewed: filesReviewed } : {}),
    ...(typeof obj.notes === "string" ? { notes: obj.notes } : {}),
  };
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
 * Fallback JSON extractor for plain-text outputs or tests.
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
