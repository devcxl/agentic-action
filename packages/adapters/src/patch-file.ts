import type { DiffFileEntry } from "@agentic-action/contracts";

/**
 * Build a filesystem-safe, deterministically ordered patch file name for a repo path.
 * Keeps the tail of the path so sibling files in deep directories stay distinguishable.
 */
export function buildPatchFileName(index: number, repoPath: string): string {
  const safeName = repoPath.replace(/[^A-Za-z0-9._-]+/g, "__").slice(-120);
  return `${String(index).padStart(3, "0")}-${safeName}.patch`;
}

/**
 * Attach pagination metadata once a written patch exceeds the single-read budget.
 * The read tool caps one call; oversized patches must be paged with offset/limit.
 */
export function applyOversizedPatchHint(
  file: DiffFileEntry,
  bytes: number,
  maxFileBytes: number,
): void {
  if (bytes <= maxFileBytes) return;
  file.oversized = true;
  file.pages = Math.ceil(bytes / maxFileBytes);
  file.note = `patch ${bytes} 字节，超过单次读取预算 ${maxFileBytes}，请用 read 的 offset/limit 分页读取（约 ${file.pages} 页）`;
  file.readVia = `read ${file.patch} （分 ${file.pages} 页，用 offset/limit 逐页读）`;
}
