import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type {
  BaseSnapshotInfo,
  DiffFileEntry,
  DiffInventory,
  SkippedFiles,
} from "@agentic-action/contracts";
import {
  DEFAULT_EXCLUDES,
  globToRegExp,
  isPathEscaping,
  matchesAny,
  parseNameStatusZ,
  parseNumstatZ,
} from "@agentic-action/core";

export interface GitExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  allowFail?: boolean;
  timeoutMs?: number;
}

export function execGit(
  args: readonly string[],
  options: GitExecOptions = {},
): string {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  try {
    return execFileSync("git", [...args], {
      cwd,
      env,
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
      timeout: options.timeoutMs ?? 120_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (options.allowFail) return "";
    const errObj = error as { stderr?: Buffer | string; message?: string };
    const stderr = errObj.stderr ? String(errObj.stderr).trim() : "";
    throw new Error(
      `git ${args.join(" ")} 失败: ${stderr || errObj.message || String(error)}`,
    );
  }
}

/**
 * Remove any persisted credentials (`http.*.extraheader`) from `.git/config`
 * so Pi's `read` tool cannot leak `GITHUB_TOKEN` from `.git/config` (fixes S2).
 */
export function scrubGitCredentials(cwd = process.cwd()): string[] {
  const unsetKeys: string[] = [];

  const matched = execGit(
    ["config", "--local", "--name-only", "--get-regexp", "^http\\..*\\.extraheader$"],
    { cwd, allowFail: true },
  )
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const keysToClean = new Set<string>([
    "http.https://github.com/.extraheader",
    ...matched,
  ]);

  for (const key of keysToClean) {
    execGit(["config", "--local", "--unset-all", key], {
      cwd,
      allowFail: true,
    });
    if (matched.includes(key)) {
      unsetKeys.push(key);
    }
  }

  return unsetKeys;
}

export function resolveBaseSha(options: {
  baseSha?: string;
  prNumber?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  githubToken?: string;
  timeoutMs?: number;
}): string {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? 60_000;

  let resolved = (options.baseSha ?? "").trim();

  if (!resolved && env.GITHUB_EVENT_PATH && existsSync(env.GITHUB_EVENT_PATH)) {
    try {
      const ev = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")) as {
        pull_request?: { base?: { sha?: string } };
      };
      resolved = ev?.pull_request?.base?.sha?.trim() ?? "";
    } catch {
      // ignore malformed event payload
    }
  }

  if (!resolved && options.prNumber) {
    try {
      resolved = execFileSync(
        "gh",
        [
          "pr",
          "view",
          String(options.prNumber),
          "--json",
          "baseRefOid",
          "--jq",
          ".baseRefOid",
        ],
        {
          cwd,
          env,
          encoding: "utf8",
          timeout: timeoutMs,
          stdio: ["ignore", "pipe", "pipe"],
        },
      ).trim();
    } catch (error) {
      const errObj = error as { stderr?: Buffer | string; message?: string };
      const stderr = errObj.stderr ? String(errObj.stderr).trim() : "";
      throw new Error(
        `gh pr view 获取 baseRefOid 失败: ${stderr || errObj.message || String(error)}`,
      );
    }
  }

  if (!resolved) {
    throw new Error(
      "无法确定 base_sha（请传入 base_sha，或在 pull_request 事件中运行，或提供 pr_number）",
    );
  }

  const existsLocal = execGit(
    ["rev-parse", "--verify", "--quiet", `${resolved}^{commit}`],
    { cwd, env, allowFail: true },
  ).trim();

  if (!existsLocal) {
    const fetchEnv: NodeJS.ProcessEnv = { ...env };
    const token =
      options.githubToken || env.INPUT_GITHUB_TOKEN || env.GH_TOKEN || env.GITHUB_TOKEN;
    if (token && token.trim()) {
      const basic = Buffer.from(`x-access-token:${token.trim()}`, "utf8").toString(
        "base64",
      );
      fetchEnv.GIT_CONFIG_COUNT = "1";
      fetchEnv.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
      fetchEnv.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${basic}`;
    }
    execGit(["fetch", "--no-tags", "origin", resolved], {
      cwd,
      env: fetchEnv,
      timeoutMs,
    });
  }

  return resolved;
}

export interface CollectDiffOptions {
  cwd?: string;
  outDir: string;
  base: string;
  head?: string;
  maxFileBytes?: number;
  maxFiles?: number;
  maxSnapshotBytes?: number;
  contextLines?: number;
  excludes?: string[];
  includes?: string[];
  noDefaultExcludes?: boolean;
  baseSnapshot?: boolean;
}

export function collectDiffInventory(
  options: CollectDiffOptions,
): DiffInventory {
  const repoCwd = options.cwd ? resolve(options.cwd) : process.cwd();
  const outDir = resolve(repoCwd, options.outDir);
  const patchDir = join(outDir, "patches");
  const headInput = options.head ?? "HEAD";
  const contextLines = options.contextLines ?? 3;
  const maxFileBytes = options.maxFileBytes ?? 400 * 1024;
  const maxFiles = options.maxFiles ?? 0;
  const maxSnapshotBytes = options.maxSnapshotBytes ?? 50 * 1024 * 1024;
  const userExcludes = options.excludes ?? [];
  const userIncludes = options.includes ?? [];
  const noDefaultExcludes = options.noDefaultExcludes ?? false;

  if (
    !execGit(["rev-parse", "--is-inside-work-tree"], {
      cwd: repoCwd,
      allowFail: true,
    }).trim()
  ) {
    throw new Error("当前目录不是 git 仓库：请在 checkout 之后运行");
  }

  if (
    execGit(["rev-parse", "--is-shallow-repository"], {
      cwd: repoCwd,
    }).trim() === "true"
  ) {
    throw new Error(
      "检测到浅克隆（shallow clone），无法计算 merge-base 与完整 diff。请在 actions/checkout 中设置 fetch-depth: 0",
    );
  }

  const baseSha = execGit(["rev-parse", "--verify", `${options.base}^{commit}`], {
    cwd: repoCwd,
  }).trim();
  const headSha = execGit(["rev-parse", "--verify", `${headInput}^{commit}`], {
    cwd: repoCwd,
  }).trim();
  const mergeBase = execGit(["merge-base", baseSha, headSha], {
    cwd: repoCwd,
  }).trim();

  const numstat = parseNumstatZ(
    execGit(["diff", "--numstat", "-z", "-M", mergeBase, headSha], {
      cwd: repoCwd,
    }),
  );
  const statusMap = parseNameStatusZ(
    execGit(["diff", "--name-status", "-z", "-M", mergeBase, headSha], {
      cwd: repoCwd,
    }),
  );

  for (const entry of numstat) {
    const meta = statusMap.get(entry.path) ?? { status: "?", oldPath: null };
    entry.status = meta.status;
    entry.oldPath = meta.oldPath ?? entry.oldPath;
  }

  const defaultPatterns = noDefaultExcludes ? [] : DEFAULT_EXCLUDES;
  const excludeRes = defaultPatterns.map(globToRegExp);
  const extraExcludeRes = userExcludes.map(globToRegExp);
  const includeRes = userIncludes.map(globToRegExp);

  const files: DiffFileEntry[] = [];
  const skipped: SkippedFiles = { excluded: [], binary: [], empty: [] };

  for (const entry of numstat) {
    const { path } = entry;
    const isBinary = entry.added === "-" || entry.deleted === "-";
    const added = isBinary ? 0 : Number(entry.added);
    const deleted = isBinary ? 0 : Number(entry.deleted);

    let excludedBy: string | null = null;
    if (includeRes.length > 0 && !matchesAny(path, includeRes)) {
      excludedBy = "not-in-include-list";
    } else if (matchesAny(path, excludeRes)) {
      excludedBy = "matches-exclude";
    } else if (extraExcludeRes.length > 0 && matchesAny(path, extraExcludeRes)) {
      excludedBy = "matches-exclude";
    }
    if (isBinary) excludedBy = excludedBy ?? "binary";

    if (excludedBy) {
      skipped[excludedBy === "binary" ? "binary" : "excluded"].push({
        path,
        reason: excludedBy,
      });
      continue;
    }
    if (added === 0 && deleted === 0) {
      skipped.empty.push({ path, reason: "no-line-change" });
      continue;
    }

    files.push({
      path,
      oldPath: entry.oldPath,
      status: entry.status ?? "M",
      added,
      deleted,
      lines: added + deleted,
      patch: null,
      bytes: 0,
      patchLines: 0,
      oversized: false,
    });
  }

  // Sort by lines descending for maxFiles truncation, then by path for deterministic patch numbering
  files.sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path));
  if (maxFiles > 0 && files.length > maxFiles) {
    for (const file of files.slice(maxFiles)) {
      skipped.excluded.push({
        path: file.path,
        reason: `over-max-files(${maxFiles})`,
        added: file.added,
        deleted: file.deleted,
      });
    }
    files.length = maxFiles;
  }
  files.sort((a, b) => a.path.localeCompare(b.path));

  rmSync(patchDir, { recursive: true, force: true });
  rmSync(join(outDir, "base"), { recursive: true, force: true });
  mkdirSync(patchDir, { recursive: true });

  let index = 0;
  for (const file of files) {
    index += 1;
    const safeName = file.path
      .replace(/[^A-Za-z0-9._-]+/g, "__")
      .slice(-120);
    const fileName = `${String(index).padStart(3, "0")}-${safeName}.patch`;
    const target = join(patchDir, fileName);

    const patchPaths = file.oldPath ? [file.oldPath, file.path] : [file.path];
    const patch = execGit(
      [
        "diff",
        "-M",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        `-U${contextLines}`,
        mergeBase,
        headSha,
        "--",
        ...patchPaths.map((p) => `:(literal)${p}`),
      ],
      { cwd: repoCwd, allowFail: true },
    );

    const bytes = Buffer.byteLength(patch, "utf8");
    writeFileSync(target, patch, "utf8");
    file.patch = `patches/${fileName}`;
    file.bytes = bytes;
    file.patchLines = patch === "" ? 0 : patch.split("\n").length - 1;
    if (bytes > maxFileBytes) {
      file.oversized = true;
      file.pages = Math.ceil(bytes / maxFileBytes);
      file.note = `patch ${bytes} 字节，超过单次读取预算 ${maxFileBytes}，请用 read 的 offset/limit 分页读取（约 ${file.pages} 页）`;
      file.readVia = `read ${file.patch} （分 ${file.pages} 页，用 offset/limit 逐页读）`;
    }
  }

  let baseSnapshot: BaseSnapshotInfo | null = null;
  if (options.baseSnapshot) {
    const snapshotDir = join(outDir, "base");
    const candidates = [
      ...new Set(
        files.flatMap((f) => (f.oldPath ? [f.oldPath, f.path] : [f.path])),
      ),
    ];
    if (candidates.length > 0) {
      let totalBytes = 0;
      let written = 0;
      let truncated = false;
      for (const relPath of candidates) {
        const content = execGit(["show", `${mergeBase}:${relPath}`], {
          cwd: repoCwd,
          allowFail: true,
        });
        if (content === "") continue;
        const size = Buffer.byteLength(content, "utf8");
        if (totalBytes + size > maxSnapshotBytes) {
          truncated = true;
          break;
        }
        const target = join(snapshotDir, relPath);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content, "utf8");
        totalBytes += size;
        written += 1;
      }
      baseSnapshot = {
        dir: "base",
        files: written,
        bytes: totalBytes,
        truncated,
      };
    }
  }

  return {
    baseSha,
    baseInput: options.base,
    headSha,
    headInput,
    mergeBase,
    contextLines,
    filesChangedTotal: numstat.length,
    files,
    skipped,
    baseSnapshot,
    excludes: {
      defaultsApplied: !noDefaultExcludes,
      defaultPatterns: [...defaultPatterns],
      userPatterns: [...userExcludes],
      includePatterns: [...userIncludes],
    },
  };
}

export interface CollectSnapshotOptions {
  cwd?: string;
  outDir: string;
  targetPath?: string;
  maxFileBytes?: number;
  maxFiles?: number;
  maxSnapshotBytes?: number;
  excludes?: string[];
  includes?: string[];
  noDefaultExcludes?: boolean;
}

const SNAPSHOT_SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".aws",
  ".ssh",
  ".gnupg",
  ".cargo",
  ".rustup",
  ".venv",
  "venv",
  ".pip",
]);

function sanitizePatchHeaderPath(rawPath: string): string {
  return rawPath.replace(/[\r\n\0-\x1f]+/g, "_");
}

function listFilesRecursively(
  repoCwd: string,
  currentDir: string,
  skipped: SkippedFiles,
  acc: string[] = [],
): string[] {
  let stat;
  try {
    stat = lstatSync(currentDir);
  } catch (err) {
    const rel = relative(repoCwd, currentDir).split("\\").join("/") || ".";
    skipped.excluded.push({
      path: rel,
      reason: `unreadable-stat: ${err instanceof Error ? err.message : String(err)}`,
    });
    return acc;
  }

  if (stat.isSymbolicLink()) {
    const rel = relative(repoCwd, currentDir).split("\\").join("/") || ".";
    skipped.excluded.push({ path: rel, reason: "symlink" });
    return acc;
  }
  if (stat.isFile()) {
    acc.push(currentDir);
    return acc;
  }
  if (!stat.isDirectory()) return acc;

  let entries;
  try {
    entries = readdirSync(currentDir, { withFileTypes: true });
  } catch (err) {
    const rel = relative(repoCwd, currentDir).split("\\").join("/") || ".";
    skipped.excluded.push({
      path: rel,
      reason: `unreadable-dir: ${err instanceof Error ? err.message : String(err)}`,
    });
    return acc;
  }

  for (const entry of entries) {
    const childPath = join(currentDir, entry.name);
    if (entry.isSymbolicLink()) {
      const rel = relative(repoCwd, childPath).split("\\").join("/");
      skipped.excluded.push({ path: rel, reason: "symlink" });
      continue;
    }
    if (entry.isDirectory() && SNAPSHOT_SKIP_DIRS.has(entry.name)) continue;
    if (entry.isDirectory()) {
      listFilesRecursively(repoCwd, childPath, skipped, acc);
    } else if (entry.isFile()) {
      acc.push(childPath);
    }
  }
  return acc;
}

function resolveSnapshotTarget(
  cwd?: string,
  rawTarget = ".",
): { repoCwd: string; realRepoCwd: string; targetAbs: string } {
  const repoCwd = cwd ? resolve(cwd) : process.cwd();
  const targetCandidate = resolve(repoCwd, rawTarget);
  if (isPathEscaping(relative(repoCwd, targetCandidate))) {
    throw new Error(`target_path 超出工作区边界: ${rawTarget}`);
  }
  if (!existsSync(targetCandidate)) {
    throw new Error(`target_path 不存在: ${rawTarget}`);
  }
  const realRepoCwd = realpathSync(repoCwd);
  const targetAbs = realpathSync(targetCandidate);
  const relCheck = relative(realRepoCwd, targetAbs);
  if (isPathEscaping(relCheck) || resolve(realRepoCwd, relCheck) !== targetAbs) {
    throw new Error(`target_path 超出工作区边界: ${rawTarget}`);
  }
  return { repoCwd, realRepoCwd, targetAbs };
}

function isCandidatePathExcluded(
  path: string,
  targetRelPath: string,
  includeRes: readonly RegExp[],
  excludeRes: readonly RegExp[],
  extraExcludeRes: readonly RegExp[],
): string | null {
  const isTemplateOrExample = /(?:\.example|\.sample|\.template)$/i.test(path);
  const matches = (patterns: readonly RegExp[]): boolean =>
    matchesAny(path, patterns) ||
    (targetRelPath !== path && matchesAny(targetRelPath, patterns));

  if (includeRes.length > 0 && !matches(includeRes)) return "not-in-include-list";
  if (!isTemplateOrExample && (matches(excludeRes) || matches(extraExcludeRes))) {
    return "matches-exclude";
  }
  return null;
}

function processSnapshotFile(
  absPath: string,
  path: string,
  maxFileBytes: number,
  totalSnapshotBytes: number,
  maxSnapshotBytes: number,
  skipped: SkippedFiles,
): { file?: DiffFileEntry; size: number } {
  let stat;
  try {
    stat = lstatSync(absPath);
  } catch (err) {
    skipped.excluded.push({
      path,
      reason: `unreadable-file-stat: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { size: 0 };
  }

  if (stat.size === 0) {
    skipped.empty.push({ path, reason: "empty-file" });
    return { size: 0 };
  }
  if (stat.size > maxFileBytes * 5) {
    skipped.excluded.push({
      path,
      reason: `over-max-file-bytes(${stat.size} > ${maxFileBytes * 5})`,
    });
    return { size: 0 };
  }
  if (totalSnapshotBytes + stat.size > maxSnapshotBytes) {
    skipped.excluded.push({
      path,
      reason: `over-max-snapshot-bytes(${maxSnapshotBytes})`,
    });
    return { size: 0 };
  }

  let buf: Buffer;
  try {
    buf = readFileSync(absPath);
  } catch (err) {
    skipped.excluded.push({
      path,
      reason: `unreadable-file: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { size: 0 };
  }
  if (buf.subarray(0, 8192).includes(0)) {
    skipped.binary.push({ path, reason: "binary" });
    return { size: 0 };
  }

  const text = buf.toString("utf8");
  const lineCount = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n").length;
  return {
    size: buf.length,
    file: {
      path,
      oldPath: null,
      status: "A",
      added: lineCount,
      deleted: 0,
      lines: lineCount,
      patch: null,
      bytes: 0,
      patchLines: 0,
      oversized: false,
    },
  };
}

function filterSnapshotCandidates(params: {
  absFiles: readonly string[];
  realRepoCwd: string;
  targetAbs: string;
  includeRes: readonly RegExp[];
  excludeRes: readonly RegExp[];
  extraExcludeRes: readonly RegExp[];
  maxFileBytes: number;
  maxSnapshotBytes: number;
  skipped: SkippedFiles;
}): DiffFileEntry[] {
  const {
    absFiles,
    realRepoCwd,
    targetAbs,
    includeRes,
    excludeRes,
    extraExcludeRes,
    maxFileBytes,
    maxSnapshotBytes,
    skipped,
  } = params;

  const files: DiffFileEntry[] = [];
  let totalBytes = 0;

  for (const absPath of absFiles) {
    const path = relative(realRepoCwd, absPath).split("\\").join("/");
    const targetRelPath = relative(targetAbs, absPath).split("\\").join("/") || path;
    const excludedBy = isCandidatePathExcluded(
      path,
      targetRelPath,
      includeRes,
      excludeRes,
      extraExcludeRes,
    );
    if (excludedBy) {
      skipped.excluded.push({ path, reason: excludedBy });
      continue;
    }

    const { file, size } = processSnapshotFile(
      absPath,
      path,
      maxFileBytes,
      totalBytes,
      maxSnapshotBytes,
      skipped,
    );
    if (file) {
      totalBytes += size;
      files.push(file);
    }
  }

  return files;
}

function writeSnapshotPatches(
  files: DiffFileEntry[],
  realRepoCwd: string,
  patchDir: string,
  maxFileBytes: number,
  skipped: SkippedFiles,
): DiffFileEntry[] {
  let index = 0;
  const writtenFiles: DiffFileEntry[] = [];
  for (const file of files) {
    let text = "";
    try {
      text = readFileSync(join(realRepoCwd, file.path), "utf8");
    } catch (err) {
      skipped.excluded.push({
        path: file.path,
        reason: `unreadable-file: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    index += 1;
    const safeName = file.path
      .replace(/[^A-Za-z0-9._-]+/g, "__")
      .slice(-120);
    const fileName = `${String(index).padStart(3, "0")}-${safeName}.patch`;
    const target = join(patchDir, fileName);

    const bodyLines = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
    const safeHeaderPath = sanitizePatchHeaderPath(file.path);
    const patch =
      `--- /dev/null\n+++ b/${safeHeaderPath}\n@@ -0,0 +1,${bodyLines.length} @@\n` +
      bodyLines.map((line) => `+${line}`).join("\n") +
      "\n";

    const bytes = Buffer.byteLength(patch, "utf8");
    writeFileSync(target, patch, "utf8");
    file.patch = `patches/${fileName}`;
    file.bytes = bytes;
    file.patchLines = patch.split("\n").length - 1;
    if (bytes > maxFileBytes) {
      file.oversized = true;
      file.pages = Math.ceil(bytes / maxFileBytes);
      file.note = `patch ${bytes} 字节，超过单次读取预算 ${maxFileBytes}，请用 read 的 offset/limit 分页读取（约 ${file.pages} 页）`;
      file.readVia = `read ${file.patch} （分 ${file.pages} 页，用 offset/limit 逐页读）`;
    }
    writtenFiles.push(file);
  }
  return writtenFiles;
}

/**
 * Collect a codebase/directory snapshot as a synthetic `DiffInventory`
 * so `security-audit` can audit third-party repositories, vendor directories,
 * or extracted archives without requiring a base git commit or PR diff.
 */
export function collectSnapshotInventory(
  options: CollectSnapshotOptions,
): DiffInventory {
  const rawTarget = (options.targetPath ?? ".").trim() || ".";
  const { repoCwd, realRepoCwd, targetAbs } = resolveSnapshotTarget(
    options.cwd,
    rawTarget,
  );
  const outDir = resolve(repoCwd, options.outDir);
  const patchDir = join(outDir, "patches");

  const maxFileBytes = options.maxFileBytes ?? 400 * 1024;
  const maxFiles = options.maxFiles ?? 0;
  const maxSnapshotBytes = options.maxSnapshotBytes ?? 50 * 1024 * 1024;
  const userExcludes = options.excludes ?? [];
  const userIncludes = options.includes ?? [];
  const noDefaultExcludes = options.noDefaultExcludes ?? false;

  const defaultPatterns = noDefaultExcludes ? [] : DEFAULT_EXCLUDES;
  const excludeRes = defaultPatterns.map(globToRegExp);
  const extraExcludeRes = userExcludes.map(globToRegExp);
  const includeRes = userIncludes.map(globToRegExp);

  const skipped: SkippedFiles = { excluded: [], binary: [], empty: [] };
  const absFiles = listFilesRecursively(realRepoCwd, targetAbs, skipped);

  const files = filterSnapshotCandidates({
    absFiles,
    realRepoCwd,
    targetAbs,
    includeRes,
    excludeRes,
    extraExcludeRes,
    maxFileBytes,
    maxSnapshotBytes,
    skipped,
  });

  files.sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path));
  if (maxFiles > 0 && files.length > maxFiles) {
    for (const file of files.slice(maxFiles)) {
      skipped.excluded.push({
        path: file.path,
        reason: `over-max-files(${maxFiles})`,
        added: file.added,
        deleted: file.deleted,
      });
    }
    files.length = maxFiles;
  }
  files.sort((a, b) => a.path.localeCompare(b.path));

  if (files.length === 0) {
    throw new Error(`target_path (${rawTarget}) 下未找到可审计的源码文件`);
  }

  rmSync(patchDir, { recursive: true, force: true });
  rmSync(join(outDir, "base"), { recursive: true, force: true });
  mkdirSync(patchDir, { recursive: true });

  const writtenFiles = writeSnapshotPatches(
    files,
    realRepoCwd,
    patchDir,
    maxFileBytes,
    skipped,
  );
  if (writtenFiles.length === 0) {
    throw new Error(`target_path (${rawTarget}) 下未找到可审计的源码文件`);
  }

  return {
    baseSha: "SNAPSHOT",
    baseInput: rawTarget,
    headSha: "WORKTREE",
    headInput: "WORKTREE",
    mergeBase: "SNAPSHOT",
    contextLines: 0,
    filesChangedTotal: absFiles.length,
    files: writtenFiles,
    skipped,
    baseSnapshot: null,
    excludes: {
      defaultsApplied: !noDefaultExcludes,
      defaultPatterns: [...defaultPatterns],
      userPatterns: [...userExcludes],
      includePatterns: [...userIncludes],
    },
  };
}
