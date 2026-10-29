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
import { join, relative, resolve } from "node:path";
import type {
  DiffFileEntry,
  DiffInventory,
  SkippedFiles,
} from "@agentic-action/contracts";
import {
  DEFAULT_EXCLUDES,
  globToRegExp,
  isPathEscaping,
  matchesAny,
} from "@agentic-action/core";
import { applyOversizedPatchHint, buildPatchFileName } from "./patch-file.ts";

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
    const fileName = buildPatchFileName(index, file.path);
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
    applyOversizedPatchHint(file, bytes, maxFileBytes);
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
