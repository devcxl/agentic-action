import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "half-cabbage";
const DEFAULT_BASE_URL = "https://new-api.devcxl.cn/v1";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 32_768;

/** 模型列表缓存有效期 */
const CACHE_TTL_MS = 120 * 60 * 1000;
/** models.dev 元数据目录缓存有效期：目录体积大、变更慢，单独放宽 */
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
/** 单次网络请求超时 */
const REQUEST_TIMEOUT_MS = 20_000;

/** Pi 的 agent 目录（与 Pi 自身的 auth.json / models.json 同目录） */
function resolveAgentDir(): string {
  const override = process.env.PI_CODING_AGENT_DIR?.trim();
  if (!override) return join(homedir(), ".pi", "agent");
  return override.startsWith("~") ? join(homedir(), override.slice(1)) : override;
}

const AGENT_DIR = resolveAgentDir();
const CACHE_FILE = join(AGENT_DIR, "half-cabbage-models-cache.json");

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
  /** 模型列表拉取时间 */
  fetchedAt: number;
  /** models.dev 元数据目录拉取时间 */
  catalogFetchedAt: number;
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
    const authPath = join(AGENT_DIR, "auth.json");
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

function combineSignals(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeoutSignal;
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([signal, timeoutSignal]);
  }
  return timeoutSignal;
}

/** 拉取 New API /v1/models 的模型 ID 列表，失败时抛错由调用方降级 */
async function fetchModelIds(baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<string[]> {
  const response = await fetch(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    signal: combineSignals(REQUEST_TIMEOUT_MS, signal),
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
async function fetchModelsDevCatalog(signal?: AbortSignal): Promise<Record<string, ModelsDevModel>> {
  const url = process.env.MODELS_DEV_URL ?? "https://models.dev/api.json";

  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: combineSignals(REQUEST_TIMEOUT_MS, signal),
    });

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

/**
 * 进程内共享的在途请求。Pi 启动时会多次触发模型刷新，
 * 共享同一份请求可避免重复下载（models.dev 目录约 6 MB）。
 */
let inFlightModelIdsKey: string | null = null;
let inFlightModelIds: Promise<string[] | null> | null = null;
let inFlightCatalog: Promise<Record<string, ModelsDevModel>> | null = null;

function requestModelIds(baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<string[] | null> {
  const key = `${baseUrl}|${apiKey.slice(-6)}`;
  if (!inFlightModelIds || inFlightModelIdsKey !== key) {
    inFlightModelIdsKey = key;
    inFlightModelIds = fetchModelIds(baseUrl, apiKey, signal)
      .catch((error: unknown) => {
        log(`failed to fetch models: ${error instanceof Error ? error.message : error}`);
        return null;
      })
      .finally(() => {
        if (inFlightModelIdsKey === key) {
          inFlightModelIds = null;
          inFlightModelIdsKey = null;
        }
      });
  }
  return inFlightModelIds;
}

function requestCatalog(signal?: AbortSignal): Promise<Record<string, ModelsDevModel>> {
  inFlightCatalog ??= fetchModelsDevCatalog(signal).finally(() => {
    inFlightCatalog = null;
  });
  return inFlightCatalog;
}

/** 等待共享请求；调用方被取消时立即返回 undefined */
async function raceSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
  if (!signal) return promise;
  if (signal.aborted) return undefined;

  return await new Promise<T | undefined>((resolve) => {
    const onAbort = () => resolve(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve(undefined);
      },
    );
  });
}

/** 合并 models.dev 元数据与兼容性配置，转换为 pi 模型定义 */
function toPiModel(id: string, meta: ModelsDevModel | undefined) {
  const hasImage = meta?.modalities?.input?.includes("image") ?? false;
  const isReasoning = meta?.reasoning ?? /r1|reasoning|thinking/i.test(id);

  const effortOption = meta?.reasoning_options?.find((opt) => opt.type === "effort");
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
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: supportsEffort,
    },
  };
}

function readCache(baseUrl: string): CacheEntry | null {
  try {
    if (!existsSync(CACHE_FILE)) return null;

    const entry = JSON.parse(readFileSync(CACHE_FILE, "utf8")) as Partial<CacheEntry>;

    if (entry.baseUrl !== baseUrl || !Array.isArray(entry.modelIds)) return null;

    return {
      baseUrl: entry.baseUrl,
      fetchedAt: entry.fetchedAt ?? 0,
      catalogFetchedAt: entry.catalogFetchedAt ?? 0,
      modelIds: entry.modelIds,
      catalog: entry.catalog ?? {},
    };
  } catch {
    return null;
  }
}

/** 原子写入：先写临时文件再 rename，避免并发刷新写出半截 JSON */
function writeCache(entry: CacheEntry): void {
  const tempFile = `${CACHE_FILE}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(CACHE_FILE), { recursive: true });
    writeFileSync(tempFile, JSON.stringify(entry));
    renameSync(tempFile, CACHE_FILE);
  } catch {
    try {
      unlinkSync(tempFile);
    } catch {
      // ignore
    }
  }
}

type PiModel = ReturnType<typeof toPiModel>;

function toPiModels(entry: CacheEntry): PiModel[] {
  return entry.modelIds.map((id) => toPiModel(id, entry.catalog[id]));
}

async function resolveCatalog(
  cached: CacheEntry | null,
  signal?: AbortSignal,
): Promise<{ models: Record<string, ModelsDevModel>; fetchedAt: number }> {
  const now = Date.now();

  if (cached && cached.catalogFetchedAt > 0 && now - cached.catalogFetchedAt < CATALOG_TTL_MS) {
    log(`using cached models.dev catalog (${Object.keys(cached.catalog).length} models)`);
    return { models: cached.catalog, fetchedAt: cached.catalogFetchedAt };
  }

  const fetched = await raceSignal(requestCatalog(signal), signal);

  if (fetched && Object.keys(fetched).length > 0) {
    return { models: fetched, fetchedAt: Date.now() };
  }

  if (cached && Object.keys(cached.catalog).length > 0) {
    log("reusing stale models.dev catalog");
    return { models: cached.catalog, fetchedAt: cached.catalogFetchedAt };
  }

  return { models: {}, fetchedAt: 0 };
}

interface LoadModelsOptions {
  signal?: AbortSignal;
  force?: boolean;
}

async function loadModels(baseUrl: string, apiKey: string, options: LoadModelsOptions = {}) {
  const { signal, force = false } = options;
  const cached = readCache(baseUrl);

  if (!force && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    log(`using cached model list (${cached.modelIds.length} models)`);
    return toPiModels(cached);
  }

  const [modelIds, catalog] = await Promise.all([
    raceSignal(requestModelIds(baseUrl, apiKey, signal), signal),
    resolveCatalog(cached, signal),
  ]);

  if (!modelIds || modelIds.length === 0) {
    if (cached) {
      log("using stale cached model list");
      return toPiModels(cached);
    }
    return [];
  }

  writeCache({
    baseUrl,
    fetchedAt: Date.now(),
    catalogFetchedAt: catalog.fetchedAt,
    modelIds,
    catalog: catalog.models,
  });

  return modelIds.map((id) => toPiModel(id, catalog.models[id]));
}

export default async function halfCabbageExtension(pi: ExtensionAPI): Promise<void> {
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

  let initialModels: PiModel[] = [];

  if (apiKey) {
    initialModels = await loadModels(endpoint, apiKey);
  } else {
    const cached = readCache(endpoint);
    if (cached) {
      log(`using cached model list without active key (${cached.modelIds.length} models)`);
      initialModels = toPiModels(cached);
    }
  }

  pi.registerProvider(PROVIDER_ID, {
    name: "Half Cabbage",
    baseUrl: endpoint,
    apiKey: apiKeyEnvName,
    api: "openai-completions",
    models: initialModels,
    refreshModels: async (context) => {
      if (context.allowNetwork === false) {
        const cached = readCache(endpoint);
        if (cached) {
          log(`offline refresh: using cached model list (${cached.modelIds.length} models)`);
          initialModels = toPiModels(cached);
          return initialModels;
        }
        return initialModels;
      }

      const activeKey =
        (context.credential?.type === "api_key" ? context.credential.key : undefined) ||
        process.env.HALF_CABBAGE_API_KEY ||
        process.env.HALF_CABBAGE_KEY ||
        getStoredAuth().key;

      if (!activeKey) {
        log("no API key available during model refresh");
        return initialModels;
      }

      const force = context.force === true;
      log(`refreshing models via API${force ? " (forced)" : ""}...`);
      const refreshed = await loadModels(endpoint, activeKey, { signal: context.signal, force });
      if (refreshed.length > 0) {
        initialModels = refreshed;
        return refreshed;
      }
      return initialModels;
    },
  });

  log(`registered ${initialModels.length} models (key: ${apiKey ? (envKey ? "env" : "stored") : "not set"})`);
}
