import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExitCode, type DiffInventory } from "@agentic-action/contracts";
import { decideGate, mergeChunkReports, planChunks } from "@agentic-action/core";
import { collectDiffInventory } from "@agentic-action/adapters";
import { runPrReview } from "@agentic-action/actions";

describe("Review Pipeline v2: Budget, Merge, Gate & End-to-End (P3)", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "agentic-review-test-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("truly slices plannedChunks by max_chunks and computes dual coverage without InvalidReport", () => {
    const inventory: DiffInventory = {
      baseSha: "aaa",
      baseInput: "aaa",
      headSha: "bbb",
      headInput: "HEAD",
      mergeBase: "aaa",
      contextLines: 3,
      filesChangedTotal: 3,
      files: [
        {
          path: "src/a/one.ts",
          oldPath: null,
          status: "M",
          added: 100,
          deleted: 10,
          lines: 110,
          patch: "patches/001.patch",
          bytes: 2000,
          patchLines: 120,
          oversized: false,
        },
        {
          path: "src/b/two.ts",
          oldPath: null,
          status: "M",
          added: 100,
          deleted: 10,
          lines: 110,
          patch: "patches/002.patch",
          bytes: 2000,
          patchLines: 120,
          oversized: false,
        },
        {
          path: "src/c/three.ts",
          oldPath: null,
          status: "M",
          added: 100,
          deleted: 10,
          lines: 110,
          patch: "patches/003.patch",
          bytes: 2000,
          patchLines: 120,
          oversized: false,
        },
      ],
      skipped: { excluded: [], binary: [], empty: [] },
      baseSnapshot: null,
      excludes: {
        defaultsApplied: true,
        defaultPatterns: [],
        userPatterns: [],
        includePatterns: [],
      },
    };

    const plan = planChunks(inventory, {
      maxChunks: 2,
      maxChunkLines: 150,
      maxChunkBytes: 40960,
    });

    expect(plan.totalChunks).toBe(3);
    expect(plan.plannedChunks).toBe(2);
    expect(plan.truncatedByBudget).toBe(true);
    expect(plan.unreviewedFiles).toEqual(["src/c/three.ts"]);

    // Suppose both planned chunks (#1 and #2) were reviewed and returned approve with 0 findings
    const merged = mergeChunkReports(
      [
        {
          chunkIndex: 1,
          summary: "Chunk 1 clean",
          verdict: "approve",
          findings: [],
          filesReviewed: 1,
        },
        {
          chunkIndex: 2,
          summary: "Chunk 2 clean",
          verdict: "approve",
          findings: [],
          filesReviewed: 1,
        },
      ],
      plan,
    );

    expect(merged.coverage.planned).toBe(1);
    expect(merged.coverage.total).toBeCloseTo(2 / 3, 3);
    // Because totalCoverage < 1, verdict is capped at "comment" (cannot be "approve")
    expect(merged.verdict).toBe("comment");

    const gate = decideGate(merged, "high");
    expect(gate.exitCode).toBe(ExitCode.Ok);
  });

  it("deduplicates findings across chunks keeping highest severity and enforces plannedCoverage gate", () => {
    const inventory: DiffInventory = {
      baseSha: "a",
      baseInput: "a",
      headSha: "b",
      headInput: "b",
      mergeBase: "a",
      contextLines: 3,
      filesChangedTotal: 2,
      files: [
        {
          path: "src/x.ts",
          oldPath: null,
          status: "M",
          added: 200,
          deleted: 0,
          lines: 200,
          patch: "patches/001.patch",
          bytes: 1000,
          patchLines: 200,
          oversized: false,
        },
        {
          path: "src/y.ts",
          oldPath: null,
          status: "M",
          added: 200,
          deleted: 0,
          lines: 200,
          patch: "patches/002.patch",
          bytes: 1000,
          patchLines: 200,
          oversized: false,
        },
      ],
      skipped: { excluded: [], binary: [], empty: [] },
      baseSnapshot: null,
      excludes: { defaultsApplied: true, defaultPatterns: [], userPatterns: [], includePatterns: [] },
    };

    const plan = planChunks(inventory, {
      maxChunks: 0,
      maxChunkLines: 250,
      maxChunkBytes: 40960,
    });
    expect(plan.plannedChunks).toBe(2);

    // Only chunk 1 succeeded -> plannedCoverage = 0.5
    const partialReport = mergeChunkReports(
      [
        {
          chunkIndex: 1,
          summary: "Partial",
          verdict: "comment",
          filesReviewed: 1,
          findings: [
            {
              file: "src/x.ts",
              line: 10,
              severity: "medium",
              category: "security",
              title: "Issue A",
              detail: "d",
              suggestion: "s",
            },
            {
              file: "src/x.ts",
              line: 10,
              severity: "critical",
              category: "security",
              title: "Issue A higher",
              detail: "d2",
              suggestion: "s2",
            },
          ],
        },
      ],
      plan,
    );

    expect(partialReport.findings).toHaveLength(1);
    expect(partialReport.findings[0]!.severity).toBe("critical");

    const gateStrict = decideGate(partialReport, "high", { allowPartial: false });
    expect(gateStrict.exitCode).toBe(ExitCode.InvalidReport);

    const gateAllowPartial = decideGate(partialReport, "high", { allowPartial: true });
    expect(gateAllowPartial.exitCode).toBe(ExitCode.GateFailed);
    expect(gateAllowPartial.hitSeverities).toContain("critical");
  });

  it("collectDiffInventory handles renames, binary files, excludes, base snapshots, and rejects shallow clones", () => {
    const repoDir = join(workDir, "tricky-repo");
    mkdirSync(join(repoDir, "src"), { recursive: true });
    mkdirSync(join(repoDir, "dist"), { recursive: true });
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, stdio: "ignore" });
    git(["init", "-q"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "test"]);
    git(["checkout", "-q", "-b", "main"]);

    let srcA = "";
    for (let i = 0; i < 30; i++) srcA += `export const a${i} = ${i};\n`;
    writeFileSync(join(repoDir, "src/a.ts"), srcA, "utf8");
    writeFileSync(join(repoDir, "package-lock.json"), "lock\n", "utf8");
    writeFileSync(join(repoDir, "dist/bundle.js"), "bundle\n", "utf8");
    writeFileSync(join(repoDir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    git(["add", "-A"]);
    git(["commit", "-qm", "base"]);
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();

    git(["mv", "src/a.ts", "src/renamed a.ts"]);
    writeFileSync(join(repoDir, "src/renamed a.ts"), `${srcA}export const a30 = 30;\n`, "utf8");
    writeFileSync(join(repoDir, "package-lock.json"), "lock-changed\n", "utf8");
    writeFileSync(join(repoDir, "dist/bundle.js"), "bundle-changed\n", "utf8");
    writeFileSync(join(repoDir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x02, 0x03]));
    git(["add", "-A"]);
    git(["commit", "-qm", "feature"]);

    const outDir = join(workDir, "ctx-out");
    const inv = collectDiffInventory({
      cwd: repoDir,
      outDir,
      base: baseSha,
      excludes: ["**/dist/**"],
      baseSnapshot: true,
    });

    expect(inv.filesChangedTotal).toBe(4);
    expect(inv.skipped.binary).toHaveLength(1);
    expect(inv.skipped.excluded).toHaveLength(2);
    expect(inv.files).toHaveLength(1);
    expect(inv.files[0]!.path).toBe("src/renamed a.ts");
    expect(inv.files[0]!.oldPath).toBe("src/a.ts");
    expect(inv.files[0]!.status.startsWith("R")).toBe(true);
    expect(existsSync(join(outDir, "base/src/a.ts"))).toBe(true);

    // Shallow clone must fail fast
    const shallowDir = join(workDir, "shallow");
    execFileSync("git", ["clone", "-q", "--depth", "1", `file://${repoDir}`, shallowDir]);
    expect(() =>
      collectDiffInventory({
        cwd: shallowDir,
        outDir: join(workDir, "shallow-out"),
        base: "HEAD",
      }),
    ).toThrow(/浅克隆|shallow clone/);
  });

  it("runPrReview returns skipped + ExitCode.Ok when no LLM credentials exist, and ExitCode.GateFailed when submit_review reports high finding", async () => {
    const repoDir = join(workDir, "pr-repo");
    mkdirSync(join(repoDir, "src"), { recursive: true });
    const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, stdio: "ignore" });
    git(["init", "-q"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "test"]);
    git(["checkout", "-q", "-b", "main"]);
    writeFileSync(join(repoDir, "src/index.ts"), "export const x = 1;\n", "utf8");
    git(["add", "-A"]);
    git(["commit", "-qm", "base"]);
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();

    writeFileSync(join(repoDir, "src/index.ts"), "export const x = eval('2');\n", "utf8");
    git(["add", "-A"]);
    git(["commit", "-qm", "head"]);

    // 1. Fork PR without credentials -> skipped + ExitCode.Ok (0)
    const skipOut = join(workDir, "skip_output.txt");
    writeFileSync(skipOut, "", "utf8");
    const skipCode = await runPrReview(
      {
        PATH: process.env.PATH,
        RUNNER_TEMP: workDir,
        GITHUB_OUTPUT: skipOut,
        INPUT_MODEL: "gpt-4o",
        INPUT_PROVIDER: "openai",
        INPUT_BASE_SHA: baseSha,
        INPUT_PR_NUMBER: "10",
        INPUT_POST_COMMENT: "false",
        INPUT_LINK_ISSUES: "false",
      },
      { cwd: repoDir },
    );
    expect(skipCode).toBe(ExitCode.Ok);
    expect(readFileSync(skipOut, "utf8")).toContain("verdict=skipped");

    // 2. Full review with submit_review tool call in JSONL mode -> GateFailed (10)
    const fakePi = join(workDir, "fake-pi-submit.mjs");
    writeFileSync(
      fakePi,
      `#!/usr/bin/env node
const ev = {
  type: "tool_execution_end",
  toolCallId: "call_rev_1",
  toolName: "submit_review",
  result: {
    content: [{ type: "text", text: "submitted" }],
    details: {
      summary: "Detected unsafe eval in src/index.ts",
      verdict: "request_changes",
      findings: [
        {
          file: "src/index.ts",
          line: 1,
          severity: "high",
          category: "security",
          title: "Unsafe eval",
          detail: "eval executes arbitrary code",
          suggestion: "Remove eval"
        }
      ]
    }
  },
  isError: false
};
process.stdout.write(JSON.stringify(ev) + "\\n");
process.stdout.write(JSON.stringify({ type: "agent_settled", aborted: false }) + "\\n");
`,
      { encoding: "utf8", mode: 0o755 },
    );

    const revOut = join(workDir, "rev_output.txt");
    writeFileSync(revOut, "", "utf8");
    const gateCode = await runPrReview(
      {
        PATH: process.env.PATH,
        PI_BIN: fakePi,
        PI_SUPPRESS_GH_ANNOTATIONS: "1",
        RUNNER_TEMP: workDir,
        GITHUB_OUTPUT: revOut,
        INPUT_MODEL: "gpt-4o",
        INPUT_PROVIDER: "openai",
        INPUT_API_KEY: "sk-test-secret-key-12345",
        INPUT_BASE_SHA: baseSha,
        INPUT_PR_NUMBER: "11",
        INPUT_FAIL_ON: "high",
        INPUT_POST_COMMENT: "false",
        INPUT_LINK_ISSUES: "false",
      },
      { cwd: repoDir },
    );

    expect(gateCode).toBe(ExitCode.GateFailed);
    const outText = readFileSync(revOut, "utf8");
    expect(outText).toContain("verdict=request_changes");
    expect(outText).toContain("findings_count=1");
    expect(outText).toContain(`exit_code=${ExitCode.GateFailed}`);
  });
});
