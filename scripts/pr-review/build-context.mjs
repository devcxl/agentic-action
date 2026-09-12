#!/usr/bin/env node
/**
 * PR 审查上下文生成器（本地 git 比对版）
 *
 * 目标：绕开 GitHub diff API 的 20000 行上限（HTTP 406 too_large），
 * 在 Runner 内基于本地全量 clone 生成"可被 Agent 分页读取"的审查上下文。
 *
 * 产物（默认输出到 .review-context/）：
 *   - patches/<NNN>-<safe>.patch   每个文件一个独立 patch（受大小保护）
 *   - manifest.json                结构化清单：统计、文件、分块、排除项
 *   - REVIEW_CONTEXT.md            给 Agent 的入口说明（含审查流程建议）
 *
 * stdout 输出 manifest 的精简 JSON 摘要；人类可读日志输出到 stderr。
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

const log = (msg) => console.error(`[build-context] ${msg}`);

const USAGE = `用法: node build-context.mjs --base <sha|ref> [options]

在 Runner 内基于本地全量 git 比对生成 PR 审查上下文（不调用 GitHub diff API）。

必填:
  --base <sha|ref>            PR 的 base，建议传 github.event.pull_request.base.sha

常用:
  --head <sha|ref>            head，默认 HEAD
  --repo <dir>                仓库目录，默认为当前目录
  --out <dir>                 产物目录，默认 .review-context
  --base-snapshot             导出 base 版本改动文件到 <out>/base/，供 Agent 直接 read 对照
  --exclude <glob,glob>       额外排除（逗号分隔）
  --include <glob,glob>       仅包含匹配项
  --max-files <n>             最多纳入 n 个文件（按改动量优先），0 = 不限

预算:
  --max-chunk-lines <n>       单个 chunk 的 patch 行数上限，默认 1500
  --max-chunk-bytes <n>       单个 chunk 的字节上限，默认 40960
  --max-file-bytes <n>        单文件 patch 分页阈值，默认 409600
  --max-snapshot-bytes <n>    base 快照字节上限，默认 52428800
  --context <n>               diff 上下文行数，默认 3

其他:
  --no-default-excludes       不使用内置的 lockfile/生成物排除规则
  --help, -h                  显示本帮助

产物: <out>/patches/*.patch、<out>/manifest.json、<out>/REVIEW_CONTEXT.md、[<out>/base/]
`;

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  const args = {
    repo: "",
    base: "",
    head: "HEAD",
    out: ".review-context",
    maxChunkLines: 1500,
    maxChunkBytes: 40 * 1024,
    maxFileBytes: 400 * 1024,
    contextLines: 3,
    excludes: [],
    includes: [],
    noDefaultExcludes: false,
    maxFiles: 0,
    baseSnapshot: false,
    maxSnapshotBytes: 50 * 1024 * 1024,
  };

  const takesValue = new Set([
    "--repo",
    "--base",
    "--head",
    "--out",
    "--max-chunk-lines",
    "--max-chunk-bytes",
    "--max-file-bytes",
    "--context",
    "--exclude",
    "--include",
    "--max-files",
    "--max-snapshot-bytes",
  ]);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--no-default-excludes") {
      args.noDefaultExcludes = true;
      continue;
    }
    if (arg === "--base-snapshot") {
      args.baseSnapshot = true;
      continue;
    }
    if (arg === "--no-base-snapshot") {
      args.baseSnapshot = false;
      continue;
    }
    if (!takesValue.has(arg)) {
      throw new Error(`未知参数: ${arg}`);
    }
    const value = argv[++i];
    if (value === undefined) throw new Error(`参数 ${arg} 缺少取值`);
    switch (arg) {
      case "--repo": args.repo = value; break;
      case "--base": args.base = value; break;
      case "--head": args.head = value; break;
      case "--out": args.out = value; break;
      case "--max-chunk-lines": args.maxChunkLines = Number(value); break;
      case "--max-chunk-bytes": args.maxChunkBytes = Number(value); break;
      case "--max-file-bytes": args.maxFileBytes = Number(value); break;
      case "--context": args.contextLines = Number(value); break;
      case "--max-files": args.maxFiles = Number(value); break;
      case "--max-snapshot-bytes": args.maxSnapshotBytes = Number(value); break;
      case "--exclude": args.excludes.push(...splitList(value)); break;
      case "--include": args.includes.push(...splitList(value)); break;
    }
  }

  if (!args.base) throw new Error("缺少 --base <sha|ref>（PR 的 base，建议传入 github.event.pull_request.base.sha）");
  for (const [name, value] of [
    ["--max-chunk-lines", args.maxChunkLines],
    ["--max-chunk-bytes", args.maxChunkBytes],
    ["--max-file-bytes", args.maxFileBytes],
    ["--context", args.contextLines],
    ["--max-files", args.maxFiles],
    ["--max-snapshot-bytes", args.maxSnapshotBytes],
  ]) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name} 必须是非负数字`);
  }
  return args;
}

function splitList(value) {
  return value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// git 工具
// ---------------------------------------------------------------------------

const NUL = String.fromCharCode(0);

/** git 命令执行目录，由 --repo 指定（默认为当前目录） */
let repoCwd = process.cwd();

function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync("git", args, {
      cwd: repoCwd,
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (allowFail) return "";
    const stderr = error.stderr ? String(error.stderr).trim() : "";
    throw new Error(`git ${args.join(" ")} 失败: ${stderr || error.message}`);
  }
}

/** 解析 git diff --numstat -z 输出。
 *  普通文件：`<added>\t<deleted>\t<path>\0`
 *  重命名/复制：`<added>\t<deleted>\t\0<oldPath>\0<newPath>\0`（第三字段为空，路径拆成两个 token）
 */
function parseNumstatZ(text) {
  const tokens = text.split(NUL);
  const entries = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (!token) { i++; continue; }
    const parts = token.split("\t");
    if (parts.length < 2) { i++; continue; }
    const [added, deleted] = parts;
    const path = parts.length > 2 ? parts.slice(2).join("\t") : "";
    if (path) {
      entries.push({ added, deleted, path, oldPath: null });
      i++;
      continue;
    }
    const oldPath = tokens[i + 1];
    const newPath = tokens[i + 2];
    if (oldPath && newPath) entries.push({ added, deleted, path: newPath, oldPath });
    i += 3;
  }
  return entries;
}

/** 解析 git diff --name-status -z 输出，返回 path -> {status, oldPath} 映射 */
function parseNameStatusZ(text) {
  const tokens = text.split(NUL).filter((token) => token !== "");
  const map = new Map();
  let i = 0;
  while (i < tokens.length) {
    const status = tokens[i++];
    if (status[0] === "R" || status[0] === "C") {
      const oldPath = tokens[i++];
      const newPath = tokens[i++];
      if (newPath !== undefined) map.set(newPath, { status, oldPath });
    } else {
      const path = tokens[i++];
      if (path !== undefined) map.set(path, { status, oldPath: null });
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// glob 匹配（支持 ** / * / ? / {a,b}，以 '/' 结尾表示目录前缀）
// ---------------------------------------------------------------------------

function globToRegExp(pattern) {
  let p = pattern.trim().replace(/^\.\//, "");
  if (p.endsWith("/")) p = `${p}**`;
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === "*") {
      if (p[i + 1] === "*") {
        // `**/` 匹配任意层级（含零层），单独的 `**` 匹配任意字符
        if (p[i + 2] === "/") { re += "(?:.*/)?"; i += 2; } else { re += ".*"; i += 1; }
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if (ch === "{") {
      const end = p.indexOf("}", i);
      if (end === -1) { re += "\\{"; } else {
        const options = p.slice(i + 1, end).split(",").map((o) => o.replace(/[.+^${}()|[\]\\]/g, "\\$&"));
        re += `(?:${options.join("|")})`;
        i = end;
      }
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

function matchesAny(path, regexps) {
  return regexps.some((re) => re.test(path));
}

// lockfile / 生成物等默认排除项，避免噪音淹没真实改动
const DEFAULT_EXCLUDES = [
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/bun.lockb",
  "**/Cargo.lock",
  "**/poetry.lock",
  "**/go.sum",
  "**/composer.lock",
  "**/*.min.js",
  "**/*.min.css",
  "**/*.map",
  "**/__snapshots__/**",
  "**/*.snap",
];

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));
  repoCwd = args.repo ? resolve(args.repo) : process.cwd();
  const outDir = resolve(repoCwd, args.out);
  const patchDir = join(outDir, "patches");

  if (!git(["rev-parse", "--is-inside-work-tree"], { allowFail: true }).trim()) {
    throw new Error("当前目录不是 git 仓库：请在 checkout 之后运行本脚本");
  }
  if (git(["rev-parse", "--is-shallow-repository"]).trim() === "true") {
    throw new Error(
      "检测到浅克隆（shallow clone），无法计算 merge-base 与完整 diff。" +
      "请在 actions/checkout 中设置 fetch-depth: 0",
    );
  }

  const baseSha = git(["rev-parse", "--verify", `${args.base}^{commit}`]).trim();
  const headSha = git(["rev-parse", "--verify", `${args.head}^{commit}`]).trim();
  const mergeBase = git(["merge-base", baseSha, headSha]).trim();

  const diffArgs = ["diff", "--numstat", "-z", "-M", mergeBase, headSha];
  const numstat = parseNumstatZ(git(diffArgs));
  const statusMap = parseNameStatusZ(git(["diff", "--name-status", "-z", "-M", mergeBase, headSha]));

  for (const entry of numstat) {
    const meta = statusMap.get(entry.path) ?? { status: "?", oldPath: null };
    entry.status = meta.status;
    entry.oldPath = meta.oldPath ?? entry.oldPath;
  }

  const excludeRes = (args.noDefaultExcludes ? [] : DEFAULT_EXCLUDES).map(globToRegExp);
  const extraExcludeRes = args.excludes.map(globToRegExp);
  const includeRes = args.includes.map(globToRegExp);

  const files = [];
  const skipped = { excluded: [], binary: [], empty: [] };

  for (const entry of numstat) {
    const { path } = entry;
    const isBinary = entry.added === "-" || entry.deleted === "-";
    const added = isBinary ? 0 : Number(entry.added);
    const deleted = isBinary ? 0 : Number(entry.deleted);

    let excludedBy = null;
    if (includeRes.length > 0 && !matchesAny(path, includeRes)) excludedBy = "not-in-include-list";
    else if (matchesAny(path, excludeRes)) excludedBy = "matches-exclude";
    else if (extraExcludeRes.length > 0 && matchesAny(path, extraExcludeRes)) excludedBy = "matches-exclude";
    if (isBinary) excludedBy = excludedBy ?? "binary";

    if (excludedBy) {
      skipped[excludedBy === "binary" ? "binary" : "excluded"].push({ path, reason: excludedBy });
      continue;
    }
    if (added === 0 && deleted === 0) {
      skipped.empty.push({ path, reason: "no-line-change" });
      continue;
    }

    files.push({
      path,
      oldPath: entry.oldPath,
      status: entry.status,
      added,
      deleted,
      lines: added + deleted,
      patch: null,
      bytes: 0,
      oversized: false,
    });
  }

  // 排序：先按改动量降序（用于 max-files 截断时保留最重改动的文件），再按路径排序供分块使用
  files.sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path));
  if (args.maxFiles > 0 && files.length > args.maxFiles) {
    for (const file of files.slice(args.maxFiles)) {
      skipped.excluded.push({
        path: file.path,
        reason: `over-max-files(${args.maxFiles})`,
        added: file.added,
        deleted: file.deleted,
      });
    }
    files.length = args.maxFiles;
  }
  // 分块按路径顺序，让同一目录/模块的改动落在同一块，提升审查连贯性
  files.sort((a, b) => a.path.localeCompare(b.path));

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(patchDir, { recursive: true });

  // 逐文件生成 patch，单文件超限则只记录不落盘
  let index = 0;
  for (const file of files) {
    index += 1;
    const safeName = file.path.replace(/[^A-Za-z0-9._-]+/g, "__").slice(-120);
    const fileName = `${String(index).padStart(3, "0")}-${safeName}.patch`;
    const target = join(patchDir, fileName);

    const patchPaths = file.oldPath ? [file.oldPath, file.path] : [file.path];
    const patch = git([
      "diff", "-M", "--no-color", "--no-ext-diff", "--no-textconv",
      `-U${args.contextLines}`, mergeBase, headSha,
      "--", ...patchPaths.map((p) => `:(literal)${p}`),
    ], { allowFail: true });

    const bytes = Buffer.byteLength(patch, "utf8");
    writeFileSync(target, patch, "utf8");
    file.patch = `patches/${fileName}`;
    file.bytes = bytes;
    file.patchLines = patch === "" ? 0 : patch.split("\n").length - 1;
    // 超过单页读取预算：仍落盘，但需用 read 的 offset/limit 分页读取
    if (bytes > args.maxFileBytes) {
      file.oversized = true;
      file.pages = Math.ceil(bytes / args.maxFileBytes);
      file.note = `patch ${bytes} 字节，超过单次读取预算 ${args.maxFileBytes}，请用 read 的 offset/limit 分页读取（约 ${file.pages} 页）`;
    }
  }

  // 可选：把 base 版本导出到 base/ 目录，供 Agent 直接 read 对照，
  // 从而无需 bash（也就无需把 GH_TOKEN 暴露给可被注入的 Agent）。
  let baseSnapshot = null;
  if (args.baseSnapshot) {
    const snapshotDir = join(outDir, "base");
    // 同时导出删除/重命名前的旧路径，否则 Agent 看不到“改动前长什么样”
    const candidates = [...new Set(files.flatMap((f) => (f.oldPath ? [f.oldPath, f.path] : [f.path])))];
    if (candidates.length > 0) {
      let totalBytes = 0;
      let written = 0;
      let truncated = false;
      for (const path of candidates) {
        const content = git(["show", `${mergeBase}:${path}`], { allowFail: true });
        if (content === "") continue;
        const size = Buffer.byteLength(content, "utf8");
        if (totalBytes + size > args.maxSnapshotBytes) { truncated = true; break; }
        const target = join(snapshotDir, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content, "utf8");
        totalBytes += size;
        written += 1;
      }
      baseSnapshot = { dir: "base", files: written, bytes: totalBytes, truncated };
    }
  }

  // 分块：按顺序累积，超过行数或字节阈值则新开一块。
  // 预算使用 patch 的实际行数/字节；超大未落盘文件用 numstat 行数估算。
  const chunks = [];
  const chunkOf = new Map();
  let current = { index: 1, lines: 0, bytes: 0, files: [] };
  for (const file of files) {
    const patchLines = file.patchLines ?? Math.ceil(file.lines * 1.5);
    const bytes = file.bytes || file.lines * 60;
    const wouldOverflow = current.files.length > 0 &&
      (current.lines + patchLines > args.maxChunkLines || current.bytes + bytes > args.maxChunkBytes);
    if (wouldOverflow) {
      chunks.push(current);
      current = { index: chunks.length + 1, lines: 0, bytes: 0, files: [] };
    }
    current.files.push(file.path);
    current.lines += patchLines;
    current.bytes += bytes;
    file.chunk = current.index;
    chunkOf.set(file.path, current.index);
  }
  if (current.files.length > 0) chunks.push(current);

  const totals = {
    filesChanged: numstat.length,
    filesIncluded: files.length,
    filesExcluded: skipped.excluded.length,
    filesBinary: skipped.binary.length,
    linesAdded: files.reduce((sum, f) => sum + f.added, 0),
    linesDeleted: files.reduce((sum, f) => sum + f.deleted, 0),
    linesChanged: files.reduce((sum, f) => sum + f.lines, 0),
    oversizedFiles: files.filter((f) => f.oversized).length,
    oversizedNote: "oversized 仅表示单个 patch 超过单页读取预算，需分页读取；这些文件仍已落盘",
    chunks: chunks.length,
  };

  // 超大 patch 的分页读取提示，供 Agent 与调试参考
  for (const file of files) {
    if (file.oversized) {
      file.readVia = `read ${file.patch} （分 ${file.pages} 页，用 offset/limit 逐页读）`;
    }
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    base: { input: args.base, sha: baseSha },
    head: { input: args.head, sha: headSha },
    mergeBase,
    diffMode: "three-dot (merge-base...head)",
    contextLines: args.contextLines,
    limits: {
      maxChunkLines: args.maxChunkLines,
      maxChunkBytes: args.maxChunkBytes,
      maxFileBytes: args.maxFileBytes,
      maxFiles: args.maxFiles,
      maxSnapshotBytes: args.maxSnapshotBytes,
    },
    baseSnapshot,
    excludes: {
      defaultsApplied: !args.noDefaultExcludes,
      defaultPatterns: args.noDefaultExcludes ? [] : DEFAULT_EXCLUDES,
      userPatterns: args.excludes,
      includePatterns: args.includes,
    },
    totals,
    chunks,
    files,
    skipped,
  };

  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  writeFileSync(join(outDir, "REVIEW_CONTEXT.md"), renderContextDoc(manifest, outDir), "utf8");

  // stdout：精简摘要，供 workflow 写入 Step Summary
  process.stdout.write(`${JSON.stringify({
    outDir: args.out,
    baseSha,
    headSha,
    mergeBase,
    totals,
    chunkSizes: chunks.map((c) => ({ index: c.index, files: c.files.length, lines: c.lines, bytes: c.bytes })),
    oversized: files.filter((f) => f.oversized).map((f) => f.path),
  }, null, 2)}\n`);

  log(`完成：${totals.filesIncluded}/${totals.filesChanged} 个文件，${totals.linesChanged} 行改动，${totals.chunks} 个分块`);
  if (statsSafe(outDir)) log(`产物目录：${outDir}`);
}

function statsSafe(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

/** 生成给 Agent 阅读的入口文档 */
function renderContextDoc(manifest, outDir) {
  const { totals } = manifest;
  const lines = [];
  lines.push("# PR Review Context", "");
  lines.push(`- base: \`${manifest.base.sha}\` (${manifest.base.input})`);
  lines.push(`- head: \`${manifest.head.sha}\` (${manifest.head.input})`);
  lines.push(`- merge-base: \`${manifest.mergeBase}\``);
  lines.push(`- diff 模式: ${manifest.diffMode}；上下文行数: -U${manifest.contextLines}`);
  lines.push("");
  lines.push("## 改动规模", "");
  lines.push(`- 变更文件: ${totals.filesChanged}（纳入审查 ${totals.filesIncluded}，排除 ${totals.filesExcluded}，二进制 ${totals.filesBinary}）`);
  lines.push(`- 行数: +${totals.linesAdded} / -${totals.linesDeleted}（共 ${totals.linesChanged}）`);
  lines.push(`- 分块: ${totals.chunks} 个（见 manifest.json 的 chunks）`);
  if (totals.oversizedFiles > 0) lines.push(`- 需分页读取的大 patch: ${totals.oversizedFiles}（仍已落盘，用 read 的 offset/limit）`);
  lines.push("");
  lines.push("## 如何读取", "");
  lines.push("- 每个文件的 patch 位于 `patches/` 目录，路径见 `manifest.json` 的 `files[].patch`。");
  lines.push("- patch 文件均小于 read 工具单次上限；大 patch 请用 read 的 offset/limit 分页读取。");
  lines.push("- 需要理解上下文时，直接 read 工作区中的完整文件（工作区即 PR head 版本）。");
  if (manifest.baseSnapshot && manifest.baseSnapshot.files > 0) {
    lines.push(`- base 版本的改动文件已导出到 \`base/\` 目录（${manifest.baseSnapshot.files} 个文件），可直接 read 对照改动前后差异。`);
    if (manifest.baseSnapshot.truncated) lines.push("- 注意：base 快照超出字节预算被截断，部分文件需自行用 git 查看。");
  }
  lines.push("- 需要查看未导出或超限的内容时，可用 `git show <sha>:<path>` / `git diff <sha> <sha>`（sha 见上方 base/head）。");
  lines.push("");
  lines.push("## 已排除（不审查）", "");
  if (manifest.excludes.defaultsApplied) {
    lines.push(`- 默认排除规则: ${manifest.excludes.defaultPatterns.join(", ")}`);
  }
  if (manifest.excludes.userPatterns.length > 0) {
    lines.push(`- 自定义排除规则: ${manifest.excludes.userPatterns.join(", ")}`);
  }
  if (manifest.excludes.includePatterns.length > 0) {
    lines.push(`- 仅包含: ${manifest.excludes.includePatterns.join(", ")}`);
  }
  lines.push("");
  lines.push("## 文件清单", "");
  lines.push("| # | 路径 | 状态 | + | - | 分块 | patch |");
  lines.push("| - | --- | --- | - | - | - | --- |");
  manifest.files.forEach((file, i) => {
    const status = file.oldPath ? `${file.status} (${file.oldPath} -> ${file.path})` : file.status;
    const patch = file.patch ? `\`${file.patch}\`` : "未生成";
    lines.push(`| ${i + 1} | \`${file.path}\` | ${status} | ${file.added} | ${file.deleted} | ${file.chunk ?? "-"} | ${patch} |`);
  });
  lines.push("");
  return lines.join("\n");
}

try {
  main();
} catch (error) {
  log(`错误: ${error.message}`);
  process.exit(1);
}
