import {
  SEVERITY_ORDER,
  type ChunkPlan,
  type ChunkReport,
  type Finding,
  type ReviewReport,
  type Severity,
  type Verdict,
} from "@agentic-action/contracts";

function severityRank(severity: Severity): number {
  return SEVERITY_ORDER.indexOf(severity);
}

/**
 * Deduplicate findings by `(file, line, category)` (or identical title on same file/line),
 * keeping the finding with the highest severity.
 */
function deduplicateFindings(findings: readonly Finding[]): Finding[] {
  const byKey = new Map<string, Finding>();

  for (const finding of findings) {
    const key = `${finding.file}::${finding.line}::${finding.category}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, finding);
      continue;
    }
    if (severityRank(finding.severity) < severityRank(existing.severity)) {
      byKey.set(key, finding);
    }
  }

  return [...byKey.values()].sort((a, b) => {
    const rankDiff = severityRank(a.severity) - severityRank(b.severity);
    if (rankDiff !== 0) return rankDiff;
    const fileDiff = a.file.localeCompare(b.file);
    if (fileDiff !== 0) return fileDiff;
    return a.line - b.line;
  });
}

/**
 * Merge per-chunk reports into a deterministic `ReviewReport` with dual coverage (`planned` and `total`).
 */
export function mergeChunkReports(
  chunkReports: readonly ChunkReport[],
  plan: ChunkPlan,
  policyNotes: readonly string[] = [],
): ReviewReport {
  const sortedReports = [...chunkReports].sort(
    (a, b) => a.chunkIndex - b.chunkIndex,
  );
  const reviewedIndices = sortedReports.map((r) => r.chunkIndex);
  const reviewedSet = new Set(reviewedIndices);

  const filesTotal = plan.filesIncluded.length;
  const filesReviewed = plan.chunks
    .filter((c) => reviewedSet.has(c.index))
    .reduce((sum, c) => sum + c.files.length, 0);

  const plannedCoverage =
    plan.plannedChunks === 0
      ? 1
      : Number((reviewedIndices.length / plan.plannedChunks).toFixed(4));
  const totalCoverage =
    plan.totalChunks === 0
      ? 1
      : Number((reviewedIndices.length / plan.totalChunks).toFixed(4));

  const findings = deduplicateFindings(
    sortedReports.flatMap((r) => r.findings),
  );

  // Determine merged verdict
  let verdict: Verdict = "approve";
  const hasRequestChanges =
    sortedReports.some((r) => r.verdict === "request_changes") ||
    findings.some((f) => f.severity === "critical" || f.severity === "high");
  const hasComment =
    sortedReports.some((r) => r.verdict === "comment") || findings.length > 0;

  if (hasRequestChanges) {
    verdict = "request_changes";
  } else if (hasComment) {
    verdict = "comment";
  } else {
    verdict = "approve";
  }

  // Per architecture-v2.md §2.4: approve is only allowed when totalCoverage === 1 and plannedCoverage === 1
  if (verdict === "approve" && (totalCoverage < 1 || plannedCoverage < 1)) {
    verdict = "comment";
  }

  const summaries = sortedReports
    .map((r) => r.summary.trim())
    .filter(Boolean);
  const summary =
    summaries.length === 1
      ? summaries[0]!
      : summaries.map((s, idx) => `(Chunk #${sortedReports[idx]!.chunkIndex}) ${s}`).join("\n\n");

  const notesList: string[] = [];
  if (plan.truncatedByBudget && plan.unreviewedFiles.length > 0) {
    notesList.push(
      `受 max_chunks=${plan.plannedChunks} 预算裁剪，共 ${plan.unreviewedFiles.length} 个文件未纳入本次审查（totalCoverage=${Math.round(totalCoverage * 100)}%）。`,
    );
  }
  for (const r of sortedReports) {
    if (r.notes && r.notes.trim()) {
      notesList.push(r.notes.trim());
    }
  }

  return {
    summary: summary || (findings.length === 0 ? "审查完成，未发现需要报告的问题。" : `发现 ${findings.length} 个问题。`),
    verdict,
    coverage: {
      planned: plannedCoverage,
      total: totalCoverage,
      chunks_reviewed: reviewedIndices,
      chunks_planned: plan.plannedChunks,
      chunks_total: plan.totalChunks,
      files_reviewed: filesReviewed,
      files_total: filesTotal,
      ...(notesList.length > 0 ? { notes: notesList.join(" ") } : {}),
    },
    findings,
    ...(policyNotes.length > 0 ? { policyNotes: [...policyNotes] } : {}),
  };
}
