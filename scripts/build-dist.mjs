#!/usr/bin/env node
/**
 * Bundle v2 entrypoints into single-file ESM executables in `dist/`
 * and verify `dist/` is up-to-date in `--check` mode.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DIST_DIR = join(ROOT, "dist");
const isCheck = process.argv.includes("--check");

const ENTRYPOINTS = [
  { name: "run-agent.js", src: "packages/actions/src/run-agent.ts" },
  { name: "review-pr.js", src: "packages/actions/src/review-pr.ts" },
  { name: "triage-issue.js", src: "packages/actions/src/triage-issue.ts" },
  { name: "setup-pi-config.js", src: "packages/actions/src/setup-pi-config.ts" },
];

function resolveEsbuildBin() {
  const localBin = join(ROOT, "node_modules", ".bin", "esbuild");
  if (existsSync(localBin)) return localBin;
  return "esbuild";
}

function bundleEntry(srcRel, outPath) {
  const esbuildBin = resolveEsbuildBin();
  execFileSync(
    esbuildBin,
    [
      join(ROOT, srcRel),
      "--bundle",
      "--platform=node",
      "--target=node22",
      "--format=esm",
      "--banner:js=import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
      `--outfile=${outPath}`,
    ],
    {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function main() {
  if (isCheck) {
    const tmp = mkdtempSync(join(tmpdir(), "agentic-action-dist-check-"));
    try {
      for (const entry of ENTRYPOINTS) {
        const expectedPath = join(DIST_DIR, entry.name);
        if (!existsSync(expectedPath)) {
          throw new Error(`Missing built file: dist/${entry.name} (run pnpm build)`);
        }
        const actualPath = join(tmp, entry.name);
        bundleEntry(entry.src, actualPath);
        const expected = readFileSync(expectedPath, "utf8");
        const actual = readFileSync(actualPath, "utf8");
        if (expected !== actual) {
          throw new Error(
            `dist/${entry.name} is out of sync with ${entry.src} (run pnpm build)`,
          );
        }
      }
      console.log("[build:check] dist/ bundles are up-to-date with source.");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    return;
  }

  mkdirSync(DIST_DIR, { recursive: true });
  for (const entry of ENTRYPOINTS) {
    const outPath = join(DIST_DIR, entry.name);
    bundleEntry(entry.src, outPath);
    console.log(`[build] Bundled ${entry.src} -> dist/${entry.name}`);
  }
}

main();
