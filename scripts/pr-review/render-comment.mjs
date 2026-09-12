#!/usr/bin/env node
/**
 * 将 Pi Agent 产出的审查结果 JSON 渲染为 PR 评论 Markdown。
 *
 * 用法：
 *   node render-comment.mjs --report <report.json> [--out <comment.md>] [--max-bytes 60000] [--fail-on high]
 *
 * 输出：
 *   - stdout      渲染后的 Markdown（供 gh pr comment --body-file 使用）
 *   - --out       同时写入文件
 *   - 退出码      --fail-on 命中时退出码 1；报告缺失/非法时退出码 2
 *
 * 长度保护：GitHub 单条评论上限 65536 字符，超出时按 finding 截断并在末尾提示。
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const COMMENT_LIMIT = 65536;
const SEVERITY_ORDER = ["critical", "high", "medium", "low"];

const USAGE = `用法: node render-comment.mjs --report <report.json> [options]

把审查结果 JSON 渲染为 PR 评论 Markdown。

  --report <path>        Agent 产出的 report.json（必填）
  --out <path>           同时写入 Markdown 文件
  --fail-on <level>      none|low|medium|high|critical（默认 none）命中时退出码 1
  --max-bytes <n>        输出字节上限，默认 64512（GitHub 单条评论上限 65536）
  --marker <name>        HTML marker 名称，默认 pi-review
  --help, -h             显示本帮助

退出码: 0 正常；1 fail-on 命中；2 报告缺失或非法
`;
const SEVERITY_ICON = { critical: "P0", high: "P1", medium: "P2", low: "P3" };
const CATEGORY_LABEL = {
  correctness: "正确性",
  security: "安全",
  compatibility: "兼容性",
  "error-handling": "错误处理",
  performance: "性能",
  maintainability: "可维护性",
  other: "其他",
};

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  const args = { report: "", out: "", maxBytes: COMMENT_LIMIT - 1024, failOn: "none", marker: "pi-review" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--report") args.report = argv[++i];
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--max-bytes") args.maxBytes = Number(argv[++i]);
    else if (arg === "--fail-on") args.failOn = argv[++i];
    else if (arg === "--marker") args.marker = argv[++i];
    else throw new Error(`未知参数: ${arg}`);
  }
  if (!args.report) throw new Error("缺少 --report <path>");
  if (!["none", "low", "medium", "high", "critical"].includes(args.failOn)) {
    throw new Error(`--fail-on 取值非法: ${args.failOn}（可选 none|low|medium|high|critical）`);
  }
  return args;
}

function normalizeReport(raw) {
  const report = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!report || typeof report !== "object") throw new Error("report 必须是 JSON 对象");
  const findings = Array.isArray(report.findings) ? report.findings : [];
  return {
    summary: typeof report.summary === "string" ? report.summary.trim() : "",
    verdict: typeof report.verdict === "string" ? report.verdict : "comment",
    coverage: report.coverage && typeof report.coverage === "object" ? report.coverage : {},
    findings: findings.map((item, index) => ({
      file: String(item?.file ?? "(unknown)"),
      line: Number.isFinite(Number(item?.line)) ? Number(item.line) : 0,
      severity: SEVERITY_ORDER.includes(item?.severity) ? item.severity : "medium",
      category: CATEGORY_LABEL[item?.category] ? item.category : "other",
      title: String(item?.title ?? `未命名问题 #${index + 1}`).trim(),
      detail: String(item?.detail ?? "").trim(),
      suggestion: String(item?.suggestion ?? "").trim(),
    })),
  };
}

function countBySeverity(findings) {
  const counts = Object.fromEntries(SEVERITY_ORDER.map((s) => [s, 0]));
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

function render(report, marker) {
  const counts = countBySeverity(report.findings);
  const lines = [];
  lines.push(`<!-- ${marker}:begin -->`);
  lines.push("## Pi Agent 代码审查");
  lines.push("");
  lines.push("| 级别 | 数量 |");
  lines.push("| --- | --- |");
  for (const severity of SEVERITY_ORDER) {
    lines.push(`| ${SEVERITY_ICON[severity]} ${severity} | ${counts[severity]} |`);
  }
  lines.push("");
  if (report.summary) {
    lines.push("### 结论");
    lines.push("");
    lines.push(report.summary);
    lines.push("");
  }

  const coverage = report.coverage ?? {};
  const coverageParts = [];
  if (coverage.chunks_total) coverageParts.push(`分块 ${coverage.chunks_reviewed?.length ?? 0}/${coverage.chunks_total}`);
  if (coverage.files_total) coverageParts.push(`文件 ${coverage.files_reviewed ?? 0}/${coverage.files_total}`);
  if (coverageParts.length > 0) {
    lines.push(`审查覆盖：${coverageParts.join("，")}`);
    if (coverage.notes) lines.push(`> ${coverage.notes}`);
    lines.push("");
  }

  if (report.findings.length === 0) {
    lines.push("未发现需要报告的问题。");
  } else {
    lines.push("### 问题清单");
    lines.push("");
    for (const severity of SEVERITY_ORDER) {
      const group = report.findings.filter((f) => f.severity === severity);
      if (group.length === 0) continue;
      lines.push(`#### ${SEVERITY_ICON[severity]} ${severity}（${group.length}）`);
      lines.push("");
      for (const finding of group) {
        const location = finding.line > 0 ? `\`${finding.file}\`:${finding.line}` : `\`${finding.file}\``;
        lines.push(`- **${finding.title}** — ${location} _(${CATEGORY_LABEL[finding.category] ?? finding.category})_`);
        if (finding.detail) lines.push(`  - 原因：${finding.detail}`);
        if (finding.suggestion) lines.push(`  - 建议：${finding.suggestion}`);
      }
      lines.push("");
    }
  }

  lines.push(`_verdict: ${report.verdict}_`);
  lines.push(`<!-- ${marker}:end -->`);
  return lines.join("\n");
}

/** 按 finding 边界截断，保证输出不超过 maxBytes */
function truncateToLimit(markdown, maxBytes) {
  if (Buffer.byteLength(markdown, "utf8") <= maxBytes) return markdown;
  const parts = markdown.split("\n");
  const kept = [];
  let size = 0;
  for (const line of parts) {
    const lineBytes = Buffer.byteLength(`${line}\n`, "utf8");
    if (size + lineBytes > maxBytes - 200) break;
    kept.push(line);
    size += lineBytes;
  }
  kept.push("");
  kept.push(`> 评论过长，已截断。完整报告见本次运行上传的 artifact \`pr-review-report\`。`);
  return kept.join("\n");
}

function severityMeets(severity, threshold) {
  if (threshold === "none") return false;
  return SEVERITY_ORDER.indexOf(severity) <= SEVERITY_ORDER.indexOf(threshold);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.report)) throw new Error(`报告文件不存在: ${args.report}（Agent 可能未按契约输出）`);

  const report = normalizeReport(readFileSync(args.report, "utf8"));
  const markdown = truncateToLimit(render(report, args.marker), args.maxBytes);

  if (args.out) writeFileSync(args.out, markdown, "utf8");
  process.stdout.write(`${markdown}\n`);

  const counts = countBySeverity(report.findings);
  const hit = SEVERITY_ORDER.filter((s) => severityMeets(s, args.failOn) && counts[s] > 0);
  console.error(
    `[render-comment] findings=${report.findings.length} ` +
    `(${SEVERITY_ORDER.map((s) => `${s}:${counts[s]}`).join(" ")}) ` +
    `verdict=${report.verdict} bytes=${Buffer.byteLength(markdown, "utf8")}`,
  );
  if (hit.length > 0) {
    console.error(`[render-comment] fail-on=${args.failOn} 命中: ${hit.join(", ")}`);
    return 1;
  }
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`[render-comment] 错误: ${error.message}`);
  process.exitCode = 2;
}
