import {
  SEVERITY_ORDER,
  type Category,
  type ReviewReport,
  type Severity,
} from "@agentic-action/contracts";
import { redactText } from "@agentic-action/core";

const COMMENT_LIMIT = 65536;

const SEVERITY_ICON: Readonly<Record<Severity, string>> = {
  critical: "P0",
  high: "P1",
  medium: "P2",
  low: "P3",
};

const CATEGORY_LABEL: Readonly<Record<Category, string>> = {
  correctness: "正确性",
  security: "安全",
  compatibility: "兼容性",
  "error-handling": "错误处理",
  performance: "性能",
  maintainability: "可维护性",
  other: "其他",
};

function countBySeverity(
  findings: ReviewReport["findings"],
): Record<Severity, number> {
  const counts: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };
  for (const finding of findings) {
    counts[finding.severity] += 1;
  }
  return counts;
}

export function renderReviewComment(
  report: ReviewReport,
  options: {
    marker?: string;
    title?: string;
    maxBytes?: number;
    secretValues?: readonly string[];
  } = {},
): string {
  const marker = options.marker || "pi-review";
  const title = options.title || "Pi Agent 代码审查";
  const maxBytes = options.maxBytes ?? COMMENT_LIMIT - 1024;
  const counts = countBySeverity(report.findings);
  const lines: string[] = [];

  lines.push(`<!-- ${marker}:begin -->`);
  lines.push(`## ${title}`);
  lines.push("");
  lines.push("| 级别 | 数量 |");
  lines.push("| --- | --- |");
  for (const severity of SEVERITY_ORDER) {
    lines.push(`| ${SEVERITY_ICON[severity]} ${severity} | ${counts[severity]} |`);
  }
  lines.push("");

  if (report.policyNotes && report.policyNotes.length > 0) {
    for (const note of report.policyNotes) {
      lines.push(`> 注意：${note}`);
    }
    lines.push("");
  }

  if (report.summary) {
    lines.push("### 结论");
    lines.push("");
    lines.push(report.summary);
    lines.push("");
  }

  const coverage = report.coverage ?? {};
  const coverageParts: string[] = [];
  if (coverage.chunks_total) {
    coverageParts.push(
      `分块 ${coverage.chunks_reviewed?.length ?? 0}/${coverage.chunks_total}（计划分块覆盖率 ${Math.round((coverage.planned ?? 1) * 100)}%，总覆盖率 ${Math.round((coverage.total ?? 1) * 100)}%）`,
    );
  }
  if (coverage.files_total) {
    coverageParts.push(`文件 ${coverage.files_reviewed ?? 0}/${coverage.files_total}`);
  }
  if (coverageParts.length > 0) {
    lines.push(`审查覆盖：${coverageParts.join("，")}`);
    if (coverage.notes) lines.push(`> ${coverage.notes}`);
    lines.push("");
  }

  if (report.findings.length === 0) {
    lines.push("未发现需要报告的问题。");
    lines.push("");
  } else {
    lines.push("### 问题清单");
    lines.push("");
    for (const severity of SEVERITY_ORDER) {
      const group = report.findings.filter((f) => f.severity === severity);
      if (group.length === 0) continue;
      lines.push(`#### ${SEVERITY_ICON[severity]} ${severity}（${group.length}）`);
      lines.push("");
      for (const finding of group) {
        const location =
          finding.line > 0 ? `\`${finding.file}\`:${finding.line}` : `\`${finding.file}\``;
        lines.push(
          `- **${finding.title}** — ${location} _(${CATEGORY_LABEL[finding.category] ?? finding.category})_`,
        );
        if (finding.detail) lines.push(`  - 原因：${finding.detail}`);
        if (finding.suggestion) lines.push(`  - 建议：${finding.suggestion}`);
      }
      lines.push("");
    }
  }

  lines.push(`_verdict: ${report.verdict}_`);
  lines.push(`<!-- ${marker}:end -->`);

  const rawMd = truncateCommentMarkdown(lines.join("\n"), maxBytes, marker);
  return redactText(rawMd, options.secretValues);
}

function truncateCommentMarkdown(
  markdown: string,
  maxBytes: number,
  marker: string,
): string {
  if (Buffer.byteLength(markdown, "utf8") <= maxBytes) return markdown;
  const endTag = `<!-- ${marker}:end -->`;
  const parts = markdown.split("\n");
  const kept: string[] = [];
  let size = 0;
  for (const line of parts) {
    if (line === endTag) continue;
    const lineBytes = Buffer.byteLength(`${line}\n`, "utf8");
    if (size + lineBytes > maxBytes - 240) break;
    kept.push(line);
    size += lineBytes;
  }
  kept.push("");
  kept.push(
    "> 评论过长，已截断。完整报告见本次运行上传的 artifact `pr-review-report`。",
  );
  kept.push(endTag);
  return kept.join("\n");
}
