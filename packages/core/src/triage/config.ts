import { parse as parseYaml } from "yaml";
import {
  PR_KINDS,
  type JevChoiceQuestion,
  type PrKind,
  type TriageConfig,
  type TriageTypeSpec,
} from "@agentic-action/contracts";

export const DEFAULT_TRIAGE_CONFIG: TriageConfig = {
  model: "jev-1.14.0",
  confidence_floor: 0.6,
  fallback: "other",
  max_body_chars: 8000,
  allow_floating_model: false,
  types: {
    bug: {
      label: "type/bug",
      description: "行为与预期不符、崩溃、回归",
      color: "d73a4a",
    },
    feature: {
      label: "type/feature",
      description: "新增能力或改进现有能力的请求",
      color: "a2eeef",
    },
    question: {
      label: "type/question",
      description: "使用方式、咨询、非缺陷类求助",
      color: "d876e3",
    },
    docs: {
      label: "type/docs",
      description: "文档缺失或错误",
      color: "0075ca",
    },
    other: {
      label: "needs-triage",
      description: "以上都不是，或信息不足以判断",
      color: "fbca04",
    },
  },
};

export const DEFAULT_PR_KIND_CRITERIA: Readonly<Record<PrKind, string>> = {
  feature: "Adds new user-facing or API functionality or enhances existing features",
  bugfix: "Fixes a bug, crash, regression, or incorrect behavior",
  refactor: "Restructures internal code without changing external behavior",
  docs: "Updates documentation, comments, or examples only",
  deps: "Updates dependency versions, lockfiles, or package manifests",
  chore: "Build scripts, CI workflows, formatting, or maintenance tasks",
};

const TYPE_KEY_REGEX = /^[a-z][a-z0-9_-]{0,31}$/;

export function cloneDefaultTriageConfig(): TriageConfig {
  return {
    ...DEFAULT_TRIAGE_CONFIG,
    types: Object.fromEntries(
      Object.entries(DEFAULT_TRIAGE_CONFIG.types).map(([k, v]) => [k, { ...v }]),
    ),
  };
}

/**
 * Parse and validate `.github/triage.yml` (or an object) per `docs/triage-design.md` §4.1.
 */
export function parseAndValidateTriageConfig(
  rawInput?: string | Record<string, unknown> | null,
): TriageConfig {
  if (rawInput === undefined || rawInput === null) {
    return cloneDefaultTriageConfig();
  }

  let parsed: unknown = rawInput;
  if (typeof rawInput === "string") {
    const trimmed = rawInput.trim();
    if (!trimmed) {
      return cloneDefaultTriageConfig();
    }
    try {
      parsed = parseYaml(trimmed);
    } catch (err) {
      throw new Error(
        `triage 配置 YAML 解析失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("triage 配置必须是对象");
  }

  const obj = parsed as Record<string, unknown>;
  const model =
    obj.model !== undefined ? String(obj.model).trim() : DEFAULT_TRIAGE_CONFIG.model;
  if (!model) {
    throw new Error("triage 配置错误: model 不能为空");
  }

  const allowFloatingModel = obj.allow_floating_model === true;
  if (
    !allowFloatingModel &&
    (model.endsWith("-latest") || model.endsWith("-preview"))
  ) {
    throw new Error(
      `triage 配置错误: model (${model}) 不得以 -latest 或 -preview 结尾，请固定版本号或显式开启 allow_floating_model: true`,
    );
  }

  const confidenceFloor =
    obj.confidence_floor !== undefined
      ? Number(obj.confidence_floor)
      : DEFAULT_TRIAGE_CONFIG.confidence_floor;
  if (
    typeof obj.confidence_floor === "boolean" ||
    !Number.isFinite(confidenceFloor) ||
    confidenceFloor <= 0 ||
    confidenceFloor > 1
  ) {
    throw new Error(
      `triage 配置错误: confidence_floor 必须在 (0, 1] 区间内，当前值: ${String(obj.confidence_floor)}`,
    );
  }

  const maxBodyChars =
    obj.max_body_chars !== undefined
      ? Number(obj.max_body_chars)
      : DEFAULT_TRIAGE_CONFIG.max_body_chars;
  if (!Number.isInteger(maxBodyChars) || maxBodyChars <= 0) {
    throw new Error(
      `triage 配置错误: max_body_chars 必须是正整数，当前值: ${String(obj.max_body_chars)}`,
    );
  }

  const rawTypes =
    obj.types !== undefined ? obj.types : DEFAULT_TRIAGE_CONFIG.types;
  if (!rawTypes || typeof rawTypes !== "object" || Array.isArray(rawTypes)) {
    throw new Error("triage 配置错误: types 必须是对象映射");
  }

  const entries = Object.entries(rawTypes as Record<string, unknown>);
  if (entries.length < 2 || entries.length > 20) {
    throw new Error(
      `triage 配置错误: types 数量必须在 2 到 20 之间，当前数量: ${entries.length}`,
    );
  }

  const types: Record<string, TriageTypeSpec> = {};
  const seenLabels = new Set<string>();

  for (const [key, rawSpec] of entries) {
    if (!TYPE_KEY_REGEX.test(key)) {
      throw new Error(
        `triage 配置错误: 类型键 "${key}" 不符合格式要求 ^[a-z][a-z0-9_-]{0,31}$`,
      );
    }
    if (!rawSpec || typeof rawSpec !== "object" || Array.isArray(rawSpec)) {
      throw new Error(`triage 配置错误: types.${key} 必须是对象`);
    }
    const spec = rawSpec as Record<string, unknown>;
    const label = typeof spec.label === "string" ? spec.label.trim() : "";
    const description =
      typeof spec.description === "string" ? spec.description.trim() : "";
    const rawColor =
      typeof spec.color === "string"
        ? spec.color.trim().replace(/^#/, "").toLowerCase()
        : undefined;

    if (!label) {
      throw new Error(`triage 配置错误: types.${key}.label 不能为空`);
    }
    if (!description) {
      throw new Error(`triage 配置错误: types.${key}.description 不能为空`);
    }
    if (rawColor !== undefined && !/^[0-9a-f]{6}$/.test(rawColor)) {
      throw new Error(
        `triage 配置错误: types.${key}.color "${spec.color}" 必须是 6 位十六进制颜色值`,
      );
    }
    if (seenLabels.has(label)) {
      throw new Error(
        `triage 配置错误: label "${label}" 重复，每个类型的 label 必须全局唯一`,
      );
    }
    seenLabels.add(label);
    const defaultColor = DEFAULT_TRIAGE_CONFIG.types[key]?.color ?? "ededed";
    types[key] = {
      label,
      description,
      color: rawColor ?? defaultColor,
    };
  }

  const fallback =
    obj.fallback !== undefined
      ? String(obj.fallback).trim()
      : DEFAULT_TRIAGE_CONFIG.fallback;
  if (!fallback || !(fallback in types)) {
    throw new Error(
      `triage 配置错误: fallback "${fallback}" 必须是 types 中已定义的键`,
    );
  }

  return {
    model,
    confidence_floor: confidenceFloor,
    fallback,
    max_body_chars: maxBodyChars,
    allow_floating_model: allowFloatingModel,
    types,
  };
}

export function buildIssueTypeQuestion(config: TriageConfig): JevChoiceQuestion {
  const criteria: Record<string, string> = {};
  for (const [key, spec] of Object.entries(config.types)) {
    criteria[key] = spec.description;
  }
  return {
    type: "choice",
    instructions: "What kind of issue is this?",
    criteria,
  };
}

export function buildPrKindQuestion(): JevChoiceQuestion {
  const criteria: Record<string, string> = {};
  for (const kind of PR_KINDS) {
    criteria[kind] = DEFAULT_PR_KIND_CRITERIA[kind];
  }
  return {
    type: "choice",
    instructions: "What kind of pull request is this?",
    criteria,
  };
}

export function getAllConfiguredLabels(config: TriageConfig): string[] {
  return Object.values(config.types).map((t) => t.label);
}

export function hasAnyConfiguredTypeLabel(
  issueLabels: readonly string[],
  config: TriageConfig,
): boolean {
  const configured = new Set(getAllConfiguredLabels(config));
  return issueLabels.some((l) => configured.has(l));
}

export function mapLabelsToIssueTypes(
  issueLabels: readonly string[],
  config: TriageConfig,
): string[] {
  const labelToType = new Map<string, string>();
  for (const [typeKey, spec] of Object.entries(config.types)) {
    if (typeKey === config.fallback) continue;
    labelToType.set(spec.label, typeKey);
  }

  const matched: string[] = [];
  for (const label of issueLabels) {
    const typeKey = labelToType.get(label);
    if (typeKey && !matched.includes(typeKey)) {
      matched.push(typeKey);
    }
  }
  return matched;
}
