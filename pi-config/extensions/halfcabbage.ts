import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "half-cabbage";
const DEFAULT_BASE_URL = "https://new-api.devcxl.cn/v1";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 32_768;

/** 模型列表缓存有效期 */
const CACHE_TTL_MS = 120 * 60 * 1000;
const CACHE_FILE = join(tmpdir(), "pi-halfcabbage-models-cache.json");

interface ModelsDevModel {
  name?: string;
  reasoning?: boolean;
  reasoning_options?: Array<{
    type?: string;
    values?: string[];
    max?: number;
  }>;
  limit?: { context?: number; output?: number };
  modalities?: { input?: string[] };
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
}

interface CacheEntry {
  baseUrl: string;
  fetchedAt: number;
  modelIds: string[];
  catalog: Record<string, ModelsDevModel>;
}

/**
 * 调试日志：默认静默。控制台输出会直接写进 TUI，打断边框渲染，
 * 因此仅在 HALF_CABBAGE_DEBUG=1 时开启。
 */
const DEBUG = process.env.HALF_CABBAGE_DEBUG === "1";
const log = (message: string) => {
  if (DEBUG) console.info(`[half-cabbage] ${message}`);
};

function normalizeBaseUrl(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function getStoredAuth(): { key?: string; baseUrl?: string } {
  try {
    const authPath = join(homedir(), ".pi", "agent", "auth.json");
    if (!existsSync(authPath)) return {};
    const data = JSON.parse(readFileSync(authPath, "utf8")) as Record<
      string,
      { type?: string; key?: string; env?: Record<string, string> }
    >;
    const entry = data[PROVIDER_ID];
    return {
      key: entry?.key,
      baseUrl: entry?.env?.HALF_CABBAGE_BASE_URL,
    };
  } catch {
    return {};
  }
}

/** 拉取 New API /v1/models 的模型 ID 列表，失败时抛错由调用方降级 */
async function fetchModelIds(baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<string[]> {
  const response = await fetch(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    signal,
  });

  if (!response.ok) {
    throw new Error(`/models failed: ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as { data?: Array<{ id?: unknown }> };

  if (!Array.isArray(body.data)) {
    throw new Error("invalid /v1/models response");
  }

  return body.data
    .map((model) => model.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .sort((a, b) => a.localeCompare(b));
}

/** 拉取 models.dev 元数据目录，任何失败都静默降级为空目录 */
async function fetchModelsDevCatalog(): Promise<Record<string, ModelsDevModel>> {
  const url = process.env.MODELS_DEV_URL ?? "https://models.dev/api.json";

  try {
    const response = await fetch(url, { headers: { Accept: "application/json" } });

    if (!response.ok) return {};

    const catalog = (await response.json()) as Record<
      string,
      { models?: Record<string, ModelsDevModel> }
    >;

    return catalog["opencode-go"]?.models ?? {};
  } catch {
    return {};
  }
}

/** 合并 models.dev 元数据与兼容性配置，转换为 pi 模型定义 */
function toPiModel(id: string, meta: ModelsDevModel | undefined) {
  const hasImage = meta?.modalities?.input?.includes("image") ?? false;
  const isReasoning = meta?.reasoning ?? /r1|reasoning|thinking/i.test(id);

  const effortOption = meta?.reasoning_options?.find((opt) => opt.type === "effort");
  // 某些原生全量推理模型（如 DeepSeek-R1）固定推理，不支持 reasoning_effort 参数
  const isFixedReasoningOnly = /r1\b/i.test(id);
  const supportsEffort = Boolean(effortOption || (isReasoning && !isFixedReasoningOnly));

  let thinkingLevelMap:
    | Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>>
    | undefined;

  if (supportsEffort) {
    if (effortOption?.values && Array.isArray(effortOption.values)) {
      const values = new Set(effortOption.values);
      thinkingLevelMap = {
        minimal: values.has("minimal") ? "minimal" : null,
        low: values.has("low") ? "low" : null,
        medium: values.has("medium") ? "medium" : null,
        high: values.has("high") ? "high" : null,
        xhigh: values.has("xhigh") ? "xhigh" : null,
        max: values.has("max") ? "max" : null,
      };
    } else {
      // 默认兜底映射：支持标准等级并显式开启 max
      thinkingLevelMap = {
        low: "low",
        medium: "medium",
        high: "high",
        max: "max",
      };
    }
  }

  return {
    id,
    name: `${meta?.name ?? id} [Half Cabbage]`,
    reasoning: isReasoning,
    thinkingLevelMap,
    input: (hasImage ? ["text", "image"] : ["text"]) as ("text" | "image")[],
    contextWindow: meta?.limit?.context ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: meta?.limit?.output ?? DEFAULT_MAX_TOKENS,
    cost: {
      input: meta?.cost?.input ?? 0,
      output: meta?.cost?.output ?? 0,
      cacheRead: meta?.cost?.cache_read ?? 0,
      cacheWrite: meta?.cost?.cache_write ?? 0,
    },
    // compat 是模型级配置（ProviderConfig 无此字段），需逐模型声明
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: supportsEffort,
    },
  };
}

function readCache(baseUrl: string): CacheEntry | null {
  try {
    if (!existsSync(CACHE_FILE)) return null;

    const entry = JSON.parse(readFileSync(CACHE_FILE, "utf8")) as CacheEntry;

    if (entry.baseUrl !== baseUrl || !Array.isArray(entry.modelIds)) return null;

    return entry;
  } catch {
    return null;
  }
}

function writeCache(baseUrl: string, modelIds: string[], catalog: Record<string, ModelsDevModel>): void {
  try {
    const entry: CacheEntry = { baseUrl, fetchedAt: Date.now(), modelIds, catalog };
    writeFileSync(CACHE_FILE, JSON.stringify(entry));
  } catch {
    // 缓存写入失败不影响注册流程
  }
}

/** 解析配置并拉取模型列表；优先用缓存，失败时回退过期缓存 */
async function loadModels(baseUrl: string, apiKey: string, signal?: AbortSignal, force = false) {
  const cached = readCache(baseUrl);

  if (!force && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    log(`using cached model list (${cached.modelIds.length} models)`);
    return cached.modelIds.map((id) => toPiModel(id, cached.catalog[id]));
  }

  const [modelIds, catalog] = await Promise.all([
    fetchModelIds(baseUrl, apiKey, signal).catch((error: unknown) => {
      if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
        return null;
      }
      log(`failed to fetch models: ${error instanceof Error ? error.message : error}`);
      return null;
    }),
    fetchModelsDevCatalog(),
  ]);

  // 请求失败或结果为空时，回退到过期缓存
  if ((modelIds === null || modelIds.length === 0) && cached) {
    log("using stale cached model list");
    return cached.modelIds.map((id) => toPiModel(id, cached.catalog[id]));
  }

  if (modelIds === null) return [];

  if (modelIds.length > 0) writeCache(baseUrl, modelIds, catalog);

  return modelIds.map((id) => toPiModel(id, catalog[id]));
}

export default async function (pi: ExtensionAPI) {
  const storedAuth = getStoredAuth();
  const rawBaseUrl = process.env.HALF_CABBAGE_BASE_URL || storedAuth.baseUrl || DEFAULT_BASE_URL;
  const endpoint = normalizeBaseUrl(rawBaseUrl);

  const envKey = process.env.HALF_CABBAGE_API_KEY || process.env.HALF_CABBAGE_KEY;
  const apiKey = envKey || storedAuth.key;
  const apiKeyEnvName = process.env.HALF_CABBAGE_API_KEY
    ? "$HALF_CABBAGE_API_KEY"
    : process.env.HALF_CABBAGE_KEY
    ? "$HALF_CABBAGE_KEY"
    : "$HALF_CABBAGE_API_KEY";

  let initialModels = [];

  if (apiKey) {
    initialModels = await loadModels(endpoint, apiKey);
  } else {
    const cached = readCache(endpoint);
    if (cached) {
      log(`using cached model list without active key (${cached.modelIds.length} models)`);
      initialModels = cached.modelIds.map((id) => toPiModel(id, cached.catalog[id]));
    }
  }

  pi.registerProvider(PROVIDER_ID, {
    name: "Half Cabbage",
    baseUrl: endpoint,
    apiKey: apiKeyEnvName,
    api: "openai-completions",
    models: initialModels,
    refreshModels: async (context) => {
      const activeKey =
        (context.credential?.type === "api_key" ? context.credential.key : undefined) ||
        process.env.HALF_CABBAGE_API_KEY ||
        process.env.HALF_CABBAGE_KEY ||
        getStoredAuth().key;

      if (!activeKey) {
        log("no API key available during model refresh");
        return initialModels;
      }

      log("refreshing models via API...");
      const refreshed = await loadModels(endpoint, activeKey, context.signal, true);
      if (refreshed.length > 0) {
        initialModels = refreshed;
        return refreshed;
      }
      return initialModels;
    },
  });

  log(`registered ${initialModels.length} models (key: ${apiKey ? (envKey ? "env" : "stored") : "not set"})`);
}
