import {
  ExitCode,
  FAIL_ON_VALUES,
  SEVERITY_ORDER,
  type FailOn,
  type GateDecision,
  type ReviewReport,
  type Severity,
} from "@agentic-action/contracts";

export function parseFailOn(raw?: string): FailOn {
  const val = (raw ?? "high").trim().toLowerCase();
  if ((FAIL_ON_VALUES as readonly string[]).includes(val)) {
    return val as FailOn;
  }
  throw new Error(
    `fail_on 取值非法: ${raw}（可选 ${FAIL_ON_VALUES.join("|")}）`,
  );
}

function severityMeets(severity: Severity, threshold: FailOn): boolean {
  if (threshold === "none") return false;
  return (
    SEVERITY_ORDER.indexOf(severity) <= SEVERITY_ORDER.indexOf(threshold)
  );
}

export function decideGate(
  report: ReviewReport,
  failOn: FailOn,
  options: { allowPartial?: boolean } = {},
): GateDecision {
  const allowPartial = options.allowPartial ?? false;

  if (report.coverage.planned < 1 && !allowPartial) {
    return {
      exitCode: ExitCode.InvalidReport,
      passed: false,
      verdict: "error",
      hitSeverities: [],
      reason: `计划内的分块未全部完成审查（plannedCoverage=${report.coverage.planned}，已审 ${report.coverage.chunks_reviewed.length}/${report.coverage.chunks_planned}）`,
    };
  }

  const counts = new Map<Severity, number>();
  for (const s of SEVERITY_ORDER) counts.set(s, 0);
  for (const finding of report.findings) {
    counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1);
  }

  const hitSeverities = SEVERITY_ORDER.filter(
    (s) => severityMeets(s, failOn) && (counts.get(s) ?? 0) > 0,
  );

  if (hitSeverities.length > 0) {
    return {
      exitCode: ExitCode.GateFailed,
      passed: false,
      verdict: report.verdict,
      hitSeverities,
      reason: `fail_on=${failOn} 命中: ${hitSeverities.join(", ")}`,
    };
  }

  return {
    exitCode: ExitCode.Ok,
    passed: true,
    verdict: report.verdict,
    hitSeverities: [],
    reason: "通过门禁检查",
  };
}
