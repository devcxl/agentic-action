#!/usr/bin/env node
/**
 * 基于 HTML Marker 的幂等 PR 评论发布器
 *
 * 解决问题：
 * `gh pr comment --edit-last` 会无差别修改当前账号（如 github-actions[bot]）
 * 在该 PR 下的最后一条评论，导致覆盖同仓库其他 Action 的评论或找不到历史审查评论。
 *
 * 方案：
 * 通过 GitHub Issues Comments API 查询包含 `<!-- <marker>:begin -->` 的既有评论，
 * 命中则 PATCH 更新最后一条匹配项，未命中则 POST 创建新评论。
 */

import { readFileSync } from "node:fs";

const USAGE = `用法: node publish-comment.mjs --repo <owner/repo> --pr <number> --body-file <path> [--marker pi-review]

通过 GitHub REST API 按 HTML marker 精确查找并幂等更新 PR 评论。
需要环境变量 GH_TOKEN 或 GITHUB_TOKEN。
`;

export function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  const args = {
    repo: process.env.GITHUB_REPOSITORY ?? "",
    pr: "",
    bodyFile: "",
    marker: "pi-review",
    apiUrl: (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, ""),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--repo") args.repo = argv[++i];
    else if (arg === "--pr") args.pr = argv[++i];
    else if (arg === "--body-file") args.bodyFile = argv[++i];
    else if (arg === "--marker") args.marker = argv[++i];
    else if (arg === "--api-url") args.apiUrl = argv[++i].replace(/\/+$/, "");
    else throw new Error(`未知参数: ${arg}`);
  }
  if (!args.repo) throw new Error("缺少 --repo <owner/repo> 或 GITHUB_REPOSITORY");
  if (!args.pr || !/^\d+$/.test(String(args.pr))) throw new Error(`无效的 --pr 编号: ${args.pr}`);
  if (!args.bodyFile) throw new Error("缺少 --body-file <path>");
  return args;
}

export function findMatchingComment(comments, marker) {
  const beginTag = `<!-- ${marker}:begin -->`;
  for (let i = comments.length - 1; i >= 0; i--) {
    const item = comments[i];
    if (item && typeof item.body === "string" && item.body.includes(beginTag)) {
      return item;
    }
  }
  return null;
}

async function githubRequest(url, { method = "GET", token, body, fetchImpl = fetch }) {
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "agentic-action-pr-review",
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetchImpl(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub API ${method} ${url} 失败 (${res.status}): ${text}`);
  }
  return res.json();
}

export async function publishComment({
  repo,
  pr,
  body,
  marker = "pi-review",
  token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
  apiUrl = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, ""),
  fetchImpl = fetch,
}) {
  if (!token) {
    throw new Error("缺少 GH_TOKEN 或 GITHUB_TOKEN，无法发布 PR 评论");
  }

  // 分页拉取 PR (issue) 评论以定位包含 marker 的评论
  const allComments = [];
  for (let page = 1; page <= 10; page++) {
    const listUrl = `${apiUrl}/repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`;
    const pageItems = await githubRequest(listUrl, { method: "GET", token, fetchImpl });
    if (!Array.isArray(pageItems) || pageItems.length === 0) break;
    allComments.push(...pageItems);
    if (pageItems.length < 100) break;
  }

  const existing = findMatchingComment(allComments, marker);
  if (existing && existing.id) {
    const updateUrl = `${apiUrl}/repos/${repo}/issues/comments/${existing.id}`;
    const updated = await githubRequest(updateUrl, {
      method: "PATCH",
      token,
      body: { body },
      fetchImpl,
    });
    console.error(`[publish-comment] 已更新既有评论 #${existing.id} (${updated.html_url || ""})`);
    return { action: "updated", commentId: existing.id, url: updated.html_url };
  }

  const createUrl = `${apiUrl}/repos/${repo}/issues/${pr}/comments`;
  const created = await githubRequest(createUrl, {
    method: "POST",
    token,
    body: { body },
    fetchImpl,
  });
  console.error(`[publish-comment] 已创建新评论 #${created.id} (${created.html_url || ""})`);
  return { action: "created", commentId: created.id, url: created.html_url };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    try {
      const args = parseArgs(process.argv.slice(2));
      const body = readFileSync(args.bodyFile, "utf8");
      await publishComment({
        repo: args.repo,
        pr: args.pr,
        body,
        marker: args.marker,
        apiUrl: args.apiUrl,
      });
    } catch (error) {
      console.error(`[publish-comment] 错误: ${error.message}`);
      process.exit(1);
    }
  })();
}
