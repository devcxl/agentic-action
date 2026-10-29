import type {
  ChunkPlan,
  ChunkSpec,
  DiffFileEntry,
  DiffInventory,
  ReviewBudget,
} from "@agentic-action/contracts";

const NUL = "\0";

export const DEFAULT_EXCLUDES = [
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
  // Credential and secret files
  "**/.env*",
  "**/.npmrc",
  "**/.netrc",
  "**/.pypirc",
  "**/*.pem",
  "**/*.key",
  "**/*.pkcs12",
  "**/*.p12",
  "**/*.pfx",
  "**/*.kdbx",
  "**/id_rsa*",
  "**/id_ed25519*",
  "**/id_ecdsa*",
  "**/id_dsa*",
];

export interface RawNumstatEntry {
  added: string;
  deleted: string;
  path: string;
  oldPath: string | null;
  status?: string;
}

export function parseNumstatZ(text: string): RawNumstatEntry[] {
  const tokens = text.split(NUL);
  const entries: RawNumstatEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (!token) {
      i++;
      continue;
    }
    const parts = token.split("\t");
    if (parts.length < 2) {
      i++;
      continue;
    }
    const added = parts[0] ?? "0";
    const deleted = parts[1] ?? "0";
    const path = parts.length > 2 ? parts.slice(2).join("\t") : "";
    if (path) {
      entries.push({ added, deleted, path, oldPath: null });
      i++;
      continue;
    }
    const oldPath = tokens[i + 1] ?? null;
    const newPath = tokens[i + 2] ?? "";
    if (oldPath && newPath) {
      entries.push({ added, deleted, path: newPath, oldPath });
    }
    i += 3;
  }
  return entries;
}

export function parseNameStatusZ(
  text: string,
): Map<string, { status: string; oldPath: string | null }> {
  const tokens = text.split(NUL).filter((token) => token !== "");
  const map = new Map<string, { status: string; oldPath: string | null }>();
  let i = 0;
  while (i < tokens.length) {
    const status = tokens[i++];
    if (!status) break;
    if (status[0] === "R" || status[0] === "C") {
      const oldPath = tokens[i++] ?? null;
      const newPath = tokens[i++];
      if (newPath !== undefined) map.set(newPath, { status, oldPath });
    } else {
      const path = tokens[i++];
      if (path !== undefined) map.set(path, { status, oldPath: null });
    }
  }
  return map;
}

export function globToRegExp(pattern: string): RegExp {
  let p = pattern.trim().replace(/^\.\//, "");
  if (p.endsWith("/")) p = `${p}**`;
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]!;
    if (ch === "*") {
      if (p[i + 1] === "*") {
        if (p[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if (ch === "{") {
      const end = p.indexOf("}", i);
      if (end === -1) {
        re += "\\{";
      } else {
        const options = p
          .slice(i + 1, end)
          .split(",")
          .map((o) => o.replace(/[.+^${}()|[\]\\]/g, "\\$&"));
        re += `(?:${options.join("|")})`;
        i = end;
      }
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(path: string, regexps: readonly RegExp[]): boolean {
  return regexps.some((re) => re.test(path));
}

function directoryClusterKey(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  return idx === -1 ? "" : filePath.slice(0, idx);
}

/**
 * Plan review chunks by directory affinity and enforce budget limits (`maxChunks`, `maxChunkLines`, `maxChunkBytes`).
 */
export function planChunks(
  inventory: DiffInventory,
  budget: Pick<ReviewBudget, "maxChunks" | "maxChunkLines" | "maxChunkBytes">,
): ChunkPlan {
  const maxChunkLines = budget.maxChunkLines > 0 ? budget.maxChunkLines : 1500;
  const maxChunkBytes = budget.maxChunkBytes > 0 ? budget.maxChunkBytes : 40 * 1024;
  const maxChunks = budget.maxChunks > 0 ? budget.maxChunks : 0;

  // Cluster by directory path first, then file name for locality
  const files: DiffFileEntry[] = [...inventory.files].sort((a, b) => {
    const dirA = directoryClusterKey(a.path);
    const dirB = directoryClusterKey(b.path);
    if (dirA !== dirB) return dirA.localeCompare(dirB);
    return a.path.localeCompare(b.path);
  });

  const allChunks: ChunkSpec[] = [];
  let current: ChunkSpec = { index: 1, files: [], lines: 0, bytes: 0 };

  for (const file of files) {
    const patchLines = file.patchLines ?? Math.ceil(file.lines * 1.5);
    const bytes = file.bytes || file.lines * 60;
    const wouldOverflow =
      current.files.length > 0 &&
      (current.lines + patchLines > maxChunkLines ||
        current.bytes + bytes > maxChunkBytes);

    if (wouldOverflow) {
      allChunks.push(current);
      current = { index: allChunks.length + 1, files: [], lines: 0, bytes: 0 };
    }

    current.files.push(file.path);
    current.lines += patchLines;
    current.bytes += bytes;
    file.chunk = current.index;
  }

  if (current.files.length > 0) {
    allChunks.push(current);
  }

  const totalChunks = allChunks.length;
  const plannedCount =
    maxChunks > 0 ? Math.min(totalChunks, maxChunks) : totalChunks;
  const chunks = allChunks.slice(0, plannedCount);
  const unreviewedChunks = allChunks.slice(plannedCount);
  const unreviewedFiles = unreviewedChunks.flatMap((c) => c.files);

  return {
    totalChunks,
    plannedChunks: plannedCount,
    truncatedByBudget: plannedCount < totalChunks,
    allChunks,
    chunks,
    filesIncluded: files,
    unreviewedFiles,
  };
}
