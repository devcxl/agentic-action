/**
 * Git diff 解析与 glob 匹配辅助工具（供 build-context 使用）
 */

const NUL = String.fromCharCode(0);

// lockfile / 生成物等默认排除项，避免噪音淹没真实改动
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
];

/**
 * 解析 git diff --numstat -z 输出。
 * 普通文件：`<added>\t<deleted>\t<path>\0`
 * 重命名/复制：`<added>\t<deleted>\t\0<oldPath>\0<newPath>\0`
 */
export function parseNumstatZ(text) {
  const tokens = text.split(NUL);
  const entries = [];
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

/**
 * 解析 git diff --name-status -z 输出，返回 path -> {status, oldPath} 映射
 */
export function parseNameStatusZ(text) {
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

/**
 * glob 匹配（支持 ** / * / ? / {a,b}，以 '/' 结尾表示目录前缀）
 */
export function globToRegExp(pattern) {
  let p = pattern.trim().replace(/^\.\//, "");
  if (p.endsWith("/")) p = `${p}**`;
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
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

export function matchesAny(path, regexps) {
  return regexps.some((re) => re.test(path));
}
