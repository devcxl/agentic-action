import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExitCode } from "@agentic-action/contracts";

describe("Bundled dist/*.js CLI entrypoints (end-to-end)", () => {
  const rootDir = resolve(import.meta.dirname, "..");
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "agentic-dist-e2e-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("executes dist/setup-pi-config.js and dist/run-agent.js as standalone bundles", () => {
    const agentDir = join(workDir, "agent-dir");
    execFileSync(process.execPath, [join(rootDir, "dist/setup-pi-config.js")], {
      cwd: workDir,
      env: {
        ...process.env,
        ACTION_PATH: rootDir,
        PI_CODING_AGENT_DIR: agentDir,
      },
      stdio: "ignore",
    });

    const settings = JSON.parse(
      readFileSync(join(agentDir, "settings.json"), "utf8"),
    );
    expect(settings.defaultProjectTrust).toBe("never");
    expect(existsSync(join(agentDir, "extensions/submit-review.ts"))).toBe(true);

    const fakePi = join(workDir, "fake-pi.mjs");
    writeFileSync(
      fakePi,
      `#!/usr/bin/env node
process.stdout.write("hello from bundled runner\\n");
`,
      { encoding: "utf8", mode: 0o755 },
    );

    const ghOut = join(workDir, "gh_out.txt");
    writeFileSync(ghOut, "", "utf8");
    execFileSync(process.execPath, [join(rootDir, "dist/run-agent.js")], {
      cwd: workDir,
      env: {
        PATH: process.env.PATH,
        PI_BIN: fakePi,
        RUNNER_TEMP: workDir,
        GITHUB_OUTPUT: ghOut,
        INPUT_PROMPT: "say hi",
        INPUT_MODEL: "gpt-4o",
        INPUT_WRITE_SUMMARY: "false",
      },
      stdio: "ignore",
    });

    const out = readFileSync(ghOut, "utf8");
    expect(out).toContain("result=hello from bundled runner");
    expect(out).toContain(`exit_code=${ExitCode.Ok}`);
  });
});
