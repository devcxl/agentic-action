import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "half-cabbage";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 32_768;

/** 模型列表缓存有效期 */
const CACHE_TTL_MS = 120 * 60 * 1000;
const CACHE_FILE = join(tmpdir(), "pi-halfcabbage-models-cache.json");

interface ModelsDevModel {
  name?: string;
  reasoning?: boolean;
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

const log = (message: string) => console.info(`[half-cabbage] ${message}`);

function normalizeBaseUrl(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

/** 拉取 New API /v1/models 的模型 ID 列表，失败时抛错由调用方降级 */
async function fetchModelIds(baseUrl: string, apiKey: string): Promise<string[]> {
  const response = await fetch(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
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
  return {
    id,
    name: `${meta?.name ?? id} [Half Cabbage]`,
    reasoning: meta?.reasoning ?? false,
    input: hasImage ? ["text", "image"] : ["text"],
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
      supportsReasoningEffort: false,
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
async function loadModels(baseUrl: string, apiKey: string) {
  const cached = readCache(baseUrl);

  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    log(`using cached model list (${cached.modelIds.length} models)`);
    return cached.modelIds.map((id) => toPiModel(id, cached.catalog[id]));
  }

  const [modelIds, catalog] = await Promise.all([
    fetchModelIds(baseUrl, apiKey).catch((error: unknown) => {
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
  const baseUrl = process.env.HALF_CABBAGE_BASE_URL;
  const apiKey = process.env.HALF_CABBAGE_API_KEY || process.env.HALF_CABBAGE_KEY;
  const apiKeyEnvName = process.env.HALF_CABBAGE_API_KEY ? "$HALF_CABBAGE_API_KEY" : "$HALF_CABBAGE_KEY";

  if (!baseUrl || !apiKey) {
    log("HALF_CABBAGE_BASE_URL / HALF_CABBAGE_API_KEY not set, skipping provider registration");
    return;
  }

  const endpoint = normalizeBaseUrl(baseUrl);
  const models = await loadModels(endpoint, apiKey);

  if (models.length === 0) {
    log("no models available, skipping provider registration");
    return;
  }

  pi.registerProvider(PROVIDER_ID, {
    name: "Half Cabbage",
    baseUrl: endpoint,
    apiKey: apiKeyEnvName,
    api: "openai-completions",
    models,
  });

  log(`registered ${models.length} models`);
}
