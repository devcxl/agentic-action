import {
  THINKING_LEVELS,
  type PolicyInput,
  type PrKind,
  type ReviewPlan,
  type ThinkingLevel,
} from "@agentic-action/contracts";

export const FOCUS_PHRASES = {
  bugRegression:
    "重点核查是否补充了能够复现该缺陷的回归测试，防止问题再次出现。",
  bugRootCause:
    "重点核查改动是否修复了问题的根本原因（Root Cause），而非仅掩盖表面症状。",
  featureSync:
    "重点核查新增或变更的公共 API、文档与测试是否同步更新并保持契约一致。",
  featureScope:
    "重点核查是否存在超出功能需求的范围蔓延（Scope Creep）或无关顺手改动。",
  depsSupplyChain:
    "重点审查 lockfile 变更、新增依赖来源与维护状态、以及版本区间是否被不当放宽。",
} as const;

/**
 * Explicit mapping from known issue type keys to allowed PrKind sets.
 * Custom issue keys not in this map never trigger mismatch warnings (§7.2).
 */
const ISSUE_TO_ALLOWED_PR_KINDS: Readonly<
  Record<string, readonly PrKind[]>
> = {
  bug: ["bugfix", "refactor", "chore"],
  feature: ["feature", "refactor"],
  docs: ["docs", "chore"],
};

function lowerThinkingByOne(level: ThinkingLevel): ThinkingLevel {
  const idx = THINKING_LEVELS.indexOf(level);
  if (idx <= 0) return THINKING_LEVELS[0];
  return THINKING_LEVELS[idx - 1]!;
}

/**
 * Pure policy router combining linked Issue types and PR kind into a `ReviewPlan`
 * (per `docs/triage-design.md` §7.1 & §7.2).
 */
export function planReviewPolicy(input: PolicyInput): ReviewPlan {
  const focus: string[] = [];
  const notes: string[] = [];
  let thinking: ThinkingLevel | undefined;

  const uniqueIssueTypes = [...new Set(input.issueTypes)];

  if (uniqueIssueTypes.includes("bug")) {
    focus.push(FOCUS_PHRASES.bugRegression, FOCUS_PHRASES.bugRootCause);
  }

  if (uniqueIssueTypes.includes("feature")) {
    focus.push(FOCUS_PHRASES.featureSync, FOCUS_PHRASES.featureScope);
  }

  if (input.prKind !== "unknown") {
    for (const issueType of uniqueIssueTypes) {
      const allowedKinds = ISSUE_TO_ALLOWED_PR_KINDS[issueType];
      if (allowedKinds && !allowedKinds.includes(input.prKind)) {
        notes.push(
          `PR 类型（${input.prKind}）与关联 Issue 类型（${issueType}）不符，请确认关联关系或改动范围。`,
        );
      }
    }
  }

  if (input.prKind === "docs") {
    const baseThinking = input.configuredThinking ?? "high";
    thinking = lowerThinkingByOne(baseThinking);
  } else if (input.prKind === "deps") {
    focus.push(FOCUS_PHRASES.depsSupplyChain);
  }

  return {
    focus,
    ...(thinking !== undefined ? { thinking } : {}),
    notes,
  };
}
