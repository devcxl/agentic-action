import {
  PR_KINDS,
  type PrKind,
  type TriageConfig,
  type TriageDecision,
} from "@agentic-action/contracts";

/**
 * Pure Verifier implementing the fixed 5-step inspection sequence
 * from `docs/triage-design.md` §5.
 */
export function verifyClassification(
  config: TriageConfig,
  response: unknown,
  questionId = "type",
): TriageDecision {
  // Step 1: Response schema validation
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    return { kind: "invalid", reason: "响应不是有效的 JSON 对象" };
  }
  const respObj = response as Record<string, unknown>;
  const model =
    typeof respObj.model === "string" ? respObj.model.trim() : "";
  if (!model) {
    return { kind: "invalid", reason: "响应缺少有效的 model 字段" };
  }

  const answers = respObj.answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
    return { kind: "invalid", reason: "响应缺少 answers 对象" };
  }

  const answerRaw = (answers as Record<string, unknown>)[questionId];
  if (!answerRaw || typeof answerRaw !== "object" || Array.isArray(answerRaw)) {
    return {
      kind: "invalid",
      reason: `响应缺少 answers.${questionId} 对象`,
    };
  }

  const answer = answerRaw as Record<string, unknown>;
  if (answer.type !== "choice") {
    return {
      kind: "invalid",
      reason: `answers.${questionId}.type 必须为 "choice"，实际为 "${String(answer.type)}"`,
    };
  }

  const confidence = answer.confidence;
  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    return {
      kind: "invalid",
      reason: `answers.${questionId}.confidence 必须在 [0, 1] 之间，实际为 ${String(confidence)}`,
    };
  }

  const probsRaw = answer.probabilities;
  if (!probsRaw || typeof probsRaw !== "object" || Array.isArray(probsRaw)) {
    return {
      kind: "invalid",
      reason: `answers.${questionId}.probabilities 必须是对象`,
    };
  }

  const allowedKeys = new Set(Object.keys(config.types));
  const probEntries = Object.entries(probsRaw as Record<string, unknown>);
  if (probEntries.length === 0) {
    return {
      kind: "invalid",
      reason: `answers.${questionId}.probabilities 不能为空`,
    };
  }

  const probabilities: Record<string, number> = {};
  let probSum = 0;

  for (const [k, v] of probEntries) {
    if (!allowedKeys.has(k)) {
      return {
        kind: "invalid",
        reason: `probabilities 包含未配置的类型键 "${k}"`,
      };
    }
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
      return {
        kind: "invalid",
        reason: `probabilities["${k}"] 非法数值: ${String(v)}`,
      };
    }
    probabilities[k] = v;
    probSum += v;
  }

  if (Math.abs(probSum - 1) > 1e-3) {
    return {
      kind: "invalid",
      reason: `probabilities 概率总和 (${probSum.toFixed(6)}) 超出 1 ± 1e-3 容差范围`,
    };
  }

  // Step 2: choice must be in configured whitelist
  const choice = typeof answer.choice === "string" ? answer.choice : "";
  if (!choice || !allowedKeys.has(choice)) {
    return {
      kind: "invalid",
      reason: `choice "${choice}" 不在配置的白名单中`,
    };
  }

  const fallbackLabel = config.types[config.fallback]!.label;

  // Step 3: choice !== fallback
  if (choice === config.fallback) {
    return {
      kind: "degraded",
      label: fallbackLabel,
      reason: "fallback_selected",
      top: choice,
      confidence,
      probabilities,
      model,
    };
  }

  // Step 4: confidence >= confidence_floor
  if (confidence < config.confidence_floor) {
    return {
      kind: "degraded",
      label: fallbackLabel,
      reason: "low_confidence",
      top: choice,
      confidence,
      probabilities,
      model,
    };
  }

  // Step 5: Accepted
  return {
    kind: "accepted",
    type: choice,
    label: config.types[choice]!.label,
    confidence,
    probabilities,
    model,
  };
}

/**
 * Verify Jev response for PR classification (`kind` question).
 * Below `confidenceFloor` or invalid returns `"unknown"` (§7.4).
 */
export function verifyPrKind(
  response: unknown,
  confidenceFloor = 0.6,
): PrKind | "unknown" {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    return "unknown";
  }
  const answers = (response as Record<string, unknown>).answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
    return "unknown";
  }
  const kindAns = (answers as Record<string, unknown>).kind;
  if (!kindAns || typeof kindAns !== "object" || Array.isArray(kindAns)) {
    return "unknown";
  }
  const ans = kindAns as Record<string, unknown>;
  if (ans.type !== "choice") return "unknown";
  const choice = typeof ans.choice === "string" ? ans.choice : "";
  const confidence =
    typeof ans.confidence === "number" ? ans.confidence : NaN;
  if (!Number.isFinite(confidence) || confidence < confidenceFloor) {
    return "unknown";
  }
  if ((PR_KINDS as readonly string[]).includes(choice)) {
    return choice as PrKind;
  }
  return "unknown";
}
