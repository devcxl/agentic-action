import type { TriageConfig } from "@agentic-action/contracts";
import { hasAnyConfiguredTypeLabel } from "@agentic-action/core";
import { computeBackoffDelayMs, defaultSleep } from "./retry.ts";

export interface GitHubComment {
  id: number;
  body?: string;
  html_url?: string;
}

export interface GitHubIssueData {
  number: number;
  title: string;
  body: string;
  labels: string[];
}

export interface GitHubRequestOptions {
  method?: string;
  token: string;
  body?: unknown;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  baseDelayMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
}

export async function githubRequest<T = unknown>(
  url: string,
  options: GitHubRequestOptions,
): Promise<T> {
  const method = options.method ?? "GET";
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 300;
  const sleep = options.sleepImpl ?? defaultSleep;

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${options.token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "agentic-action-v2",
  };
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const res = await fetchImpl(url, {
      method,
      headers,
      body:
        options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });

    if (res.ok) {
      return (await res.json()) as T;
    }

    const status = res.status;
    const text = await res.text().catch(() => "");
    const retryable = status === 429 || (status >= 500 && status <= 599);

    lastError = new Error(
      `GitHub API ${method} ${url} 失败 (${status}): ${text.slice(0, 300)}`,
    );

    if (!retryable || attempt > maxRetries) {
      throw lastError;
    }

    const retryAfterHeader =
      typeof res.headers?.get === "function"
        ? res.headers.get("retry-after")
        : null;
    await sleep(computeBackoffDelayMs(attempt, baseDelayMs, retryAfterHeader));
  }

  throw lastError ?? new Error(`GitHub API ${method} ${url} 失败`);
}

export function findMatchingComment(
  comments: readonly GitHubComment[],
  marker: string,
): GitHubComment | null {
  const beginTag = `<!-- ${marker}:begin -->`;
  for (let i = comments.length - 1; i >= 0; i--) {
    const item = comments[i];
    if (item && typeof item.body === "string" && item.body.includes(beginTag)) {
      return item;
    }
  }
  return null;
}

/**
 * Paginate through ALL issue/PR comments without the v1 10-page silent cap.
 */
export async function listAllIssueComments(options: {
  repo: string;
  pr: string | number;
  token: string;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  baseDelayMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
}): Promise<GitHubComment[]> {
  const apiUrl = (options.apiUrl || "https://api.github.com").replace(
    /\/+$/,
    "",
  );
  const allComments: GitHubComment[] = [];
  let page = 1;

  while (true) {
    const listUrl = `${apiUrl}/repos/${options.repo}/issues/${options.pr}/comments?per_page=100&page=${page}`;
    const pageItems = await githubRequest<GitHubComment[]>(listUrl, {
      method: "GET",
      token: options.token,
      fetchImpl: options.fetchImpl,
      maxRetries: options.maxRetries,
      baseDelayMs: options.baseDelayMs,
      sleepImpl: options.sleepImpl,
    });
    if (!Array.isArray(pageItems) || pageItems.length === 0) break;
    allComments.push(...pageItems);
    if (pageItems.length < 100) break;
    page += 1;
  }

  return allComments;
}

export async function upsertMarkerComment(options: {
  repo: string;
  pr: string | number;
  body: string;
  marker?: string;
  token?: string;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  baseDelayMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
}): Promise<{
  action: "updated" | "created";
  commentId: number;
  url?: string;
}> {
  const token = (options.token ?? "").trim();
  if (!token) {
    throw new Error("缺少 GH_TOKEN 或 GITHUB_TOKEN，无法发布 PR 评论");
  }
  const marker = options.marker || "pi-review";
  const apiUrl = (options.apiUrl || "https://api.github.com").replace(
    /\/+$/,
    "",
  );

  const allComments = await listAllIssueComments({
    repo: options.repo,
    pr: options.pr,
    token,
    apiUrl,
    fetchImpl: options.fetchImpl,
    maxRetries: options.maxRetries,
    baseDelayMs: options.baseDelayMs,
    sleepImpl: options.sleepImpl,
  });

  const existing = findMatchingComment(allComments, marker);
  if (existing && existing.id) {
    const updateUrl = `${apiUrl}/repos/${options.repo}/issues/comments/${existing.id}`;
    const updated = await githubRequest<GitHubComment>(updateUrl, {
      method: "PATCH",
      token,
      body: { body: options.body },
      fetchImpl: options.fetchImpl,
      maxRetries: options.maxRetries,
      baseDelayMs: options.baseDelayMs,
      sleepImpl: options.sleepImpl,
    });
    return {
      action: "updated",
      commentId: existing.id,
      url: updated.html_url,
    };
  }

  const createUrl = `${apiUrl}/repos/${options.repo}/issues/${options.pr}/comments`;
  const created = await githubRequest<GitHubComment>(createUrl, {
    method: "POST",
    token,
    body: { body: options.body },
    fetchImpl: options.fetchImpl,
    maxRetries: options.maxRetries,
    baseDelayMs: options.baseDelayMs,
    sleepImpl: options.sleepImpl,
  });
  return {
    action: "created",
    commentId: created.id,
    url: created.html_url,
  };
}

export async function getIssueDetails(options: {
  repo: string;
  issueNumber: string | number;
  token: string;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<GitHubIssueData> {
  const apiUrl = (options.apiUrl || "https://api.github.com").replace(
    /\/+$/,
    "",
  );
  const url = `${apiUrl}/repos/${options.repo}/issues/${options.issueNumber}`;
  const data = await githubRequest<{
    number: number;
    title?: string;
    body?: string | null;
    labels?: Array<string | { name?: string }>;
  }>(url, {
    method: "GET",
    token: options.token,
    fetchImpl: options.fetchImpl,
  });

  const labels = (data.labels ?? [])
    .map((l) => (typeof l === "string" ? l : (l?.name ?? "")))
    .filter(Boolean);

  return {
    number: data.number ?? Number(options.issueNumber),
    title: data.title ?? "",
    body: data.body ?? "",
    labels,
  };
}

export async function getRepoLabelNames(options: {
  repo: string;
  token: string;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<Set<string>> {
  const apiUrl = (options.apiUrl || "https://api.github.com").replace(
    /\/+$/,
    "",
  );
  const names = new Set<string>();
  let page = 1;

  while (true) {
    const url = `${apiUrl}/repos/${options.repo}/labels?per_page=100&page=${page}`;
    const items = await githubRequest<Array<{ name?: string }>>(url, {
      method: "GET",
      token: options.token,
      fetchImpl: options.fetchImpl,
    });
    if (!Array.isArray(items) || items.length === 0) break;
    for (const item of items) {
      if (item && typeof item.name === "string" && item.name.trim()) {
        names.add(item.name.trim());
      }
    }
    if (items.length < 100) break;
    page += 1;
  }

  return names;
}

/**
 * Idempotent Executor for issue triage labels:
 * 1. If the issue already has any configured type label (including fallback), skip and do 0 writes.
 * 2. Ensure the target label (which must be declared in `config.types`) exists in the repo;
 *    if missing in the repo, automatically create it from the `.github/triage.yml` definition
 *    (handling concurrent 422 `already_exists` idempotently).
 * 3. Add only the target label (`POST /repos/{repo}/issues/{issue}/labels`).
 */
export async function applyTriageLabelIdempotent(options: {
  repo: string;
  issueNumber: string | number;
  targetLabel: string;
  config: TriageConfig;
  existingIssueLabels?: readonly string[];
  token: string;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<{
  action: "applied" | "skipped_existing";
  label: string;
  existingLabels: string[];
  createdLabels: string[];
}> {
  const apiUrl = (options.apiUrl || "https://api.github.com").replace(
    /\/+$/,
    "",
  );

  const existingLabels =
    options.existingIssueLabels !== undefined
      ? [...options.existingIssueLabels]
      : (
          await getIssueDetails({
            repo: options.repo,
            issueNumber: options.issueNumber,
            token: options.token,
            apiUrl,
            fetchImpl: options.fetchImpl,
          })
        ).labels;

  if (hasAnyConfiguredTypeLabel(existingLabels, options.config)) {
    return {
      action: "skipped_existing",
      label: options.targetLabel,
      existingLabels,
      createdLabels: [],
    };
  }

  const configuredSpecsByLabel = new Map(
    Object.values(options.config.types).map((spec) => [spec.label, spec]),
  );
  const targetSpec = configuredSpecsByLabel.get(options.targetLabel);
  if (!targetSpec) {
    throw new Error(
      `目标标签 "${options.targetLabel}" 未在 triage 配置中声明，拒绝创建或打标`,
    );
  }

  const repoLabels = await getRepoLabelNames({
    repo: options.repo,
    token: options.token,
    apiUrl,
    fetchImpl: options.fetchImpl,
  });

  const createdLabels: string[] = [];
  for (const spec of configuredSpecsByLabel.values()) {
    if (repoLabels.has(spec.label)) continue;
    const createLabelUrl = `${apiUrl}/repos/${options.repo}/labels`;
    try {
      await githubRequest(createLabelUrl, {
        method: "POST",
        token: options.token,
        body: {
          name: spec.label,
          color: (spec.color || "ededed").replace(/^#/, ""),
          description: spec.description.slice(0, 100),
        },
        fetchImpl: options.fetchImpl,
      });
      repoLabels.add(spec.label);
      createdLabels.push(spec.label);
    } catch (err) {
      // Ignore 422 already_exists from concurrent workflow runs
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("(422)")) {
        throw err;
      }
      repoLabels.add(spec.label);
    }
  }

  const addUrl = `${apiUrl}/repos/${options.repo}/issues/${options.issueNumber}/labels`;
  await githubRequest(addUrl, {
    method: "POST",
    token: options.token,
    body: { labels: [options.targetLabel] },
    fetchImpl: options.fetchImpl,
  });

  return {
    action: "applied",
    label: options.targetLabel,
    existingLabels,
    createdLabels,
  };
}

/**
 * Parse closing issue references (`Fixes #12`, `Closes owner/repo#34`, `Resolves #56`), capped at `maxCount` (default 3).
 */
export function extractClosingIssueNumbers(
  text: string,
  currentRepo?: string,
  maxCount = 3,
): number[] {
  if (!text) return [];
  const regex =
    /\b(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s*:?\s+(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#(\d+)\b/gi;
  const numbers: number[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const refRepo = match[1];
    const num = Number(match[2]);
    if (!Number.isInteger(num) || num <= 0) continue;
    if (
      refRepo &&
      currentRepo &&
      refRepo.toLowerCase() !== currentRepo.toLowerCase()
    ) {
      continue;
    }
    if (!numbers.includes(num)) {
      numbers.push(num);
      if (numbers.length >= maxCount) break;
    }
  }

  return numbers;
}

export async function fetchLinkedIssues(options: {
  repo: string;
  prNumber?: string | number;
  prBody?: string;
  token: string;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
  maxCount?: number;
}): Promise<GitHubIssueData[]> {
  const maxCount = options.maxCount ?? 3;
  const apiUrl = (options.apiUrl || "https://api.github.com").replace(
    /\/+$/,
    "",
  );

  let prBody = options.prBody ?? "";
  if (!prBody && options.prNumber) {
    try {
      const prData = await getIssueDetails({
        repo: options.repo,
        issueNumber: options.prNumber,
        token: options.token,
        apiUrl,
        fetchImpl: options.fetchImpl,
      });
      prBody = prData.body;
    } catch {
      // ignore if PR fetch fails
    }
  }

  const issueNums = extractClosingIssueNumbers(prBody, options.repo, maxCount);
  const results: GitHubIssueData[] = [];

  for (const num of issueNums) {
    try {
      const issue = await getIssueDetails({
        repo: options.repo,
        issueNumber: num,
        token: options.token,
        apiUrl,
        fetchImpl: options.fetchImpl,
      });
      results.push(issue);
    } catch {
      // ignore inaccessible issue
    }
  }

  return results;
}
