/**
 * Web Search extension — Exa Search API (https://exa.ai/docs)
 *
 * Registers a `web_search` tool callable by the LLM, backed by:
 *   POST https://api.exa.ai/search
 *
 * Auth: reads the API key from the EXA_API_KEY environment variable.
 * Get one at https://dashboard.exa.ai/api-keys
 *
 * Implements the Search API reference faithfully:
 *  - Search types: auto (default), fast, instant, deep-lite, deep, deep-reasoning
 *  - Content modes nested under `contents` (text / highlights / summary),
 *    with `maxAgeHours: 0` to force livecrawl and `maxCharacters` to cap tokens
 *  - Domain filters (includeDomains / excludeDomains), category filters,
 *    published-date ranges, userLocation, moderation
 *  - Highlights-by-default for agent workflows (10x fewer tokens than text)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";

// Override with EXA_API_ENDPOINT for proxies/mocks (e.g. https://api.exa.ai/search)
const EXA_SEARCH_ENDPOINT = process.env.EXA_API_ENDPOINT ?? "https://api.exa.ai/search";
const REQUEST_TIMEOUT_MS = 120_000; // deep-reasoning can take up to ~40s + synthesis

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SEARCH_TYPES = ["auto", "fast", "instant", "deep-lite", "deep", "deep-reasoning"] as const;
const CATEGORIES = ["company", "people", "publication", "news", "personal site", "financial report"] as const;
const CONTENT_MODES = ["highlights", "text", "summary", "none"] as const;

const webSearchParams = Type.Object({
  query: Type.String({
    description:
      "Natural language search query. Supports long, semantically rich descriptions.",
  }),
  type: Type.Optional(
    StringEnum(SEARCH_TYPES, {
      description:
        "Search method. auto (default) balances speed and quality; fast/instant for low latency; deep-lite/deep/deep-reasoning for multi-step synthesized research.",
    }),
  ),
  numResults: Type.Optional(
    Type.Integer({
      description: "Number of results to return (1-100). Default: 10.",
      minimum: 1,
      maximum: 100,
    }),
  ),
  category: Type.Optional(
    StringEnum(CATEGORIES, {
      description:
        "Focus on specific content. Note: company and people do NOT support excludeDomains, startPublishedDate, or endPublishedDate (they return a 400 error).",
    }),
  ),
  contentMode: Type.Optional(
    StringEnum(CONTENT_MODES, {
      description:
        "What page content to fetch. highlights (default) returns key excerpts relevant to the query — most token-efficient for agent workflows. text returns full page text (use maxCharacters to cap). summary returns an LLM-generated summary. none returns titles/URLs only.",
    }),
  ),
  maxCharacters: Type.Optional(
    Type.Integer({
      description:
        "Character cap for returned text or highlights per result. For text mode, defaults to 8000 to avoid flooding the context window.",
      minimum: 1,
    }),
  ),
  maxAgeHours: Type.Optional(
    Type.Integer({
      description:
        "Max age of cached content in hours. 0 = always livecrawl (fresh but slower). -1 = never livecrawl (cache only). Omit for default (livecrawl as fallback). Use 0 for real-time information.",
    }),
  ),
  includeDomains: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Only return results from these domains. Accepts domains, path prefixes (e.g. exa.ai/blog), and subdomain wildcards (e.g. *.substack.com). Max 1200. Do not duplicate with a site: operator in the query.",
    }),
  ),
  excludeDomains: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Exclude results from these domains. Not supported with category company or people.",
    }),
  ),
  startPublishedDate: Type.Optional(
    Type.String({
      description:
        "ISO 8601 date (e.g. 2025-01-01). Only return links published after this date. Not supported with category company or people.",
    }),
  ),
  endPublishedDate: Type.Optional(
    Type.String({
      description:
        "ISO 8601 date. Only return links published before this date. Not supported with category company or people.",
    }),
  ),
  userLocation: Type.Optional(
    Type.String({
      description: "Two-letter ISO country code (e.g. 'US') to localize results.",
      minLength: 2,
      maxLength: 2,
    }),
  ),
  moderation: Type.Optional(
    Type.Boolean({
      description: "Filter unsafe content from results. Default: false.",
    }),
  ),
});

type WebSearchParams = Static<typeof webSearchParams>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getApiKey(): string {
  const key = process.env.EXA_API_KEY;
  if (!key) {
    throw new Error(
      "未设置 EXA_API_KEY 环境变量。请在 https://dashboard.exa.ai/api-keys 获取 API 密钥，并导出 EXA_API_KEY=<你的密钥>（或将其添加到 shell 配置文件 / pi 设置的环境变量中）。",
    );
  }
  return key;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Build the /search request body per the Search API reference.
 * NOTE: text/highlights/summary must be nested inside `contents` — top-level
 * text/summary/highlights are a common mistake that returns a 400.
 */
function buildRequestBody(p: WebSearchParams): Record<string, unknown> {
  const body: Record<string, unknown> = {
    query: p.query,
    type: p.type ?? "auto",
    numResults: p.numResults ?? 10,
  };

  if (p.category) body.category = p.category;
  if (p.userLocation) body.userLocation = p.userLocation;
  if (p.includeDomains && p.includeDomains.length > 0) body.includeDomains = p.includeDomains;
  if (p.excludeDomains && p.excludeDomains.length > 0) body.excludeDomains = p.excludeDomains;
  if (p.startPublishedDate) body.startPublishedDate = p.startPublishedDate;
  if (p.endPublishedDate) body.endPublishedDate = p.endPublishedDate;
  if (p.moderation) body.moderation = true;

  const mode = p.contentMode ?? "highlights";
  if (mode !== "none") {
    const contents: Record<string, unknown> = {};
    if (mode === "highlights") {
      // Prefer highlights: true for the highest-quality default; only pass an
      // object when the caller has a specific character budget.
      contents.highlights = p.maxCharacters ? { maxCharacters: p.maxCharacters } : true;
    } else if (mode === "text") {
      contents.text = { maxCharacters: p.maxCharacters ?? 8000 };
    } else if (mode === "summary") {
      contents.summary = true;
    }
    if (p.maxAgeHours !== undefined) contents.maxAgeHours = p.maxAgeHours;
    body.contents = contents;
  }

  return body;
}

interface SearchResult {
  title?: string;
  url?: string;
  publishedDate?: string | null;
  author?: string | null;
  highlights?: string[];
  summary?: string;
  text?: string;
}

function formatResults(results: SearchResult[], mode: string): string {
  const lines: string[] = [];
  results.forEach((r, i) => {
    const title = r.title?.trim() || "（无标题）";
    lines.push(`${i + 1}. ${title}`);
    if (r.url) lines.push(`   网址：${r.url}`);
    const meta: string[] = [];
    if (r.publishedDate) meta.push(`发布于：${r.publishedDate}`);
    if (r.author) meta.push(`作者：${r.author}`);
    if (meta.length > 0) lines.push(`   ${meta.join(" | ")}`);

    if (mode === "highlights" && r.highlights && r.highlights.length > 0) {
      for (const h of r.highlights.slice(0, 6)) {
        lines.push(`   - ${truncate(h.replace(/\s+/g, " ").trim(), 600)}`);
      }
    } else if (mode === "summary" && r.summary) {
      lines.push(`   摘要：${truncate(r.summary.replace(/\s+/g, " ").trim(), 1000)}`);
    } else if (mode === "text" && r.text) {
      lines.push(`   ${truncate(r.text.replace(/\s+/g, " ").trim(), 2500)}`);
    }
  });
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function webSearchExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "网络搜索",
    description:
      "通过 Exa Search API 搜索网络。支持自然语言查询、域名过滤、新闻/出版物/公司分类、发布日期范围，以及三种内容模式：highlights（默认；返回与查询相关的关键摘录，对 Token 最友好）、text（完整页面内容）和 summary（LLM 生成的概述）。用于时事、事实查询、研究、文档查询和信息核实。需要 EXA_API_KEY。",
    promptSnippet: "Search the web for up-to-date information, articles, and sources",
    promptGuidelines: [
      "Use web_search for questions requiring current, external, or verifiable information instead of relying on training data.",
      "Prefer web_search's default highlights contentMode for quick factual lookups; use contentMode text only when full page context is needed, and set maxCharacters to cap tokens.",
      "Use maxAgeHours: 0 with web_search when the answer must reflect real-time information.",
    ],
    parameters: webSearchParams,
    renderShell: "self",

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const apiKey = getApiKey();

      onUpdate?.({
        content: [{ type: "text", text: "正在搜索网络…" }],
        details: { progress: 30 },
      });

      const body = buildRequestBody(params);
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

      let response: Response;
      try {
        response = await fetch(EXA_SEARCH_ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: combined,
        });
      } catch (err) {
        if (signal?.aborted) {
          return {
            content: [{ type: "text", text: "搜索已取消。" }],
            details: { error: "cancelled" },
          };
        }
        throw new Error(`网络搜索请求失败：${(err as Error).message}`);
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        payload = undefined;
      }

      const apiError = (payload as { error?: string } | undefined)?.error;

      if (!response.ok) {
        const status = response.status;
        let message = apiError ?? `Exa API 错误（HTTP ${status}）`;
        if (status === 401) {
          message =
            "Exa API 密钥无效或缺失。请设置 EXA_API_KEY 为 https://dashboard.exa.ai/api-keys 中的有效密钥";
        } else if (status === 429) {
          message = "Exa API 请求频率超限（HTTP 429）。请稍后重试或降低请求频率。";
        } else if (status === 400) {
          message = `请求无效——参数不合法，或所选分类不支持该筛选条件：${message}`;
        } else if (status === 422) {
          message = `校验错误——请检查参数类型与约束：${message}`;
        }
        throw new Error(message);
      }

      const data = payload as {
        requestId?: string;
        searchType?: string;
        results?: SearchResult[];
        costDollars?: { total?: number };
      };
      const results = data.results ?? [];
      const mode = params.contentMode ?? "highlights";

      onUpdate?.({
        content: [{ type: "text", text: `找到 ${results.length} 条结果。` }],
        details: { progress: 80 },
      });

      const formatted = formatResults(results, mode);
      const text =
        formatted.length > 0
          ? formatted
          : "未找到结果。请尝试改写查询或放宽筛选条件。";

      const textContent =
        mode === "none"
          ? text
          : `${text}\n\n（搜索类型：${data.searchType ?? params.type ?? "auto"}${data.costDollars?.total ? `，费用：$${data.costDollars.total.toFixed(4)}` : ""}）`;

      return {
        content: [{ type: "text", text: textContent }],
        details: {
          requestId: data.requestId,
          searchType: data.searchType,
          count: results.length,
          results: results.map((r) => ({
            title: r.title,
            url: r.url,
            publishedDate: r.publishedDate ?? null,
            author: r.author ?? null,
            highlights: r.highlights,
            summary: r.summary,
          })),
        },
      };
    },

    // -----------------------------------------------------------------------
    // Custom TUI rendering
    // -----------------------------------------------------------------------

    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const a = args as Partial<WebSearchParams>;
      let content = theme.fg("toolTitle", theme.bold("web_search "));
      content += theme.fg("accent", `"${truncate(a.query ?? "", 60)}"`);
      const meta: string[] = [];
      if (a.type && a.type !== "auto") meta.push(a.type);
      if (a.numResults) meta.push(`${a.numResults} 条结果`);
      if (a.category) meta.push(a.category);
      if (a.maxAgeHours === 0) meta.push("实时抓取");
      if (meta.length > 0) content += " " + theme.fg("dim", meta.join(" · "));
      text.setText(content);
      return text;
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) {
        return new Text(theme.fg("warning", "正在搜索网络…"), 0, 0);
      }

      const d = result.details as
        | { error?: string; count?: number; results?: Array<{ title?: string; url?: string }> }
        | undefined;

      if (d?.error === "cancelled") {
        return new Text(theme.fg("warning", "搜索已取消"), 0, 0);
      }
      if (!d || d.error) {
        return new Text(theme.fg("error", `搜索失败：${d?.error ?? "未知错误"}`), 0, 0);
      }

      let content = theme.fg("success", `✓ ${d.count ?? 0} 条结果`);
      if (expanded && d.results) {
        for (const r of d.results.slice(0, 10)) {
          content += "\n" + theme.fg("accent", r.title ?? "（无标题）");
          if (r.url) content += "\n  " + theme.fg("dim", r.url);
        }
      }
      return new Text(content, 0, 0);
    },
  });
}
