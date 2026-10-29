import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectSnapshotInventory } from "../packages/adapters/src/git.ts";

describe("collectSnapshotInventory", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "agentic-snapshot-test-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("collects files and writes synthetic patches in snapshot mode", () => {
    const pkgDir = join(workDir, "vendor/my-lib");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "a.js"), "const x = 1;\nconsole.log(x);\n", "utf8");
    writeFileSync(join(pkgDir, "b.ts"), "export const b = 2;\n", "utf8");

    const outDir = join(workDir, "audit-context");
    const inventory = collectSnapshotInventory({
      cwd: workDir,
      targetPath: "vendor/my-lib",
      outDir,
    });

    expect(inventory.files.length).toBe(2);
    expect(inventory.baseSha).toBe("SNAPSHOT");
    expect(inventory.headSha).toBe("WORKTREE");

    const patchFile = join(outDir, inventory.files[0].patch!);
    const patchContent = readFileSync(patchFile, "utf8");
    expect(patchContent).toContain("--- /dev/null");
    expect(patchContent).toContain("+++ b/");
  });

  it("skips symlinks and records them in skipped.excluded with reason symlink", () => {
    const pkgDir = join(workDir, "vendor/sym-lib");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "real.js"), "const real = true;\n", "utf8");

    try {
      symlinkSync(join(pkgDir, "real.js"), join(pkgDir, "symlink.js"));
    } catch {
      // In case runner doesn't have symlink permission
      return;
    }

    const outDir = join(workDir, "audit-context");
    const inventory = collectSnapshotInventory({
      cwd: workDir,
      targetPath: "vendor/sym-lib",
      outDir,
    });

    expect(inventory.files.length).toBe(1);
    expect(inventory.files[0].path).toBe("vendor/sym-lib/real.js");
    expect(inventory.skipped.excluded.some((s) => s.reason === "symlink")).toBe(true);
  });

  it("rejects target_path that escapes outside workDir", () => {
    const outDir = join(workDir, "audit-context");
    expect(() =>
      collectSnapshotInventory({
        cwd: workDir,
        targetPath: "../escaped",
        outDir,
      }),
    ).toThrow(/target_path 超出工作区边界/);
  });

  it("rejects nonexistent target_path", () => {
    const outDir = join(workDir, "audit-context");
    expect(() =>
      collectSnapshotInventory({
        cwd: workDir,
        targetPath: "nonexistent-dir",
        outDir,
      }),
    ).toThrow(/target_path 不存在/);
  });

  it("throws when target_path contains no auditable source files", () => {
    const emptyDir = join(workDir, "empty-dir");
    mkdirSync(emptyDir, { recursive: true });
    const outDir = join(workDir, "audit-context");
    expect(() =>
      collectSnapshotInventory({
        cwd: workDir,
        targetPath: "empty-dir",
        outDir,
      }),
    ).toThrow(/未找到可审计的源码文件/);
  });

  it("enforces maxSnapshotBytes budget and tags oversized files", () => {
    const pkgDir = join(workDir, "oversized-lib");
    mkdirSync(pkgDir, { recursive: true });
    // Write 5KB file
    writeFileSync(join(pkgDir, "large.js"), "a".repeat(5000), "utf8");

    const outDir = join(workDir, "audit-context");
    const inventory = collectSnapshotInventory({
      cwd: workDir,
      targetPath: "oversized-lib",
      outDir,
      maxFileBytes: 2000,
      maxSnapshotBytes: 10000,
    });

    expect(inventory.files.length).toBe(1);
    expect(inventory.files[0].oversized).toBe(true);
    expect(inventory.files[0].pages).toBe(Math.ceil(inventory.files[0].bytes / 2000));
  });
});
