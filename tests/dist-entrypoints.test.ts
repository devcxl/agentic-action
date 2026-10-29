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
    expect(existsSync(join(agentDir, "extensions/ci-logger.ts"))).toBe(true);
    expect(existsSync(join(agentDir, "extensions/submit-review.ts"))).toBe(false);

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

  it("validates repository .github/triage.yml and executes dist/triage-issue.js & dist/review-pr.js", async () => {
    const { parseAndValidateTriageConfig } = await import("@agentic-action/core");
    const repoTriageYaml = readFileSync(join(rootDir, ".github/triage.yml"), "utf8");
    const parsedConfig = parseAndValidateTriageConfig(repoTriageYaml);
    expect(parsedConfig.model).toBe("jev-1.14.0");
    expect(parsedConfig.fallback).toBe("other");

    // Test dist/triage-issue.js with existing label idempotency
    const triageOut = join(workDir, "triage_out.txt");
    writeFileSync(triageOut, "", "utf8");
    execFileSync(process.execPath, [join(rootDir, "dist/triage-issue.js")], {
      cwd: rootDir,
      env: {
        PATH: process.env.PATH,
        RUNNER_TEMP: workDir,
        GITHUB_OUTPUT: triageOut,
        INPUT_ISSUE_NUMBER: "1",
        INPUT_ISSUE_TITLE: "Bug report",
        INPUT_ISSUE_LABELS: "type/bug",
        INPUT_TRIAGE_CONFIG: ".github/triage.yml",
        INPUT_APPLY_LABEL: "false",
      },
      stdio: "ignore",
    });
    const triageOutText = readFileSync(triageOut, "utf8");
    expect(triageOutText).toContain("verdict=skipped_existing");
    expect(triageOutText).toContain(`exit_code=${ExitCode.Ok}`);
  });

  it("audits a third-party directory in codebase snapshot mode without git history", async () => {
    const { runPrReview } = await import("@agentic-action/actions");
    const thirdPartyDir = join(workDir, "vendor-pkg");
    mkdirSync(thirdPartyDir, { recursive: true });
    writeFileSync(
      join(thirdPartyDir, "index.js"),
      'const { exec } = require("node:child_process");\nexports.run = (cmd) => exec(cmd);\n',
      "utf8",
    );

    const fakePi = join(workDir, "fake-pi-audit.mjs");
    writeFileSync(
      fakePi,
      `#!/usr/bin/env node
const event = {
  type: "tool_execution_end",
  toolName: "submit_review",
  isError: false,
  result: {
    details: {
      summary: "Found command injection in vendor-pkg/index.js.",
      verdict: "request_changes",
      findings: [
        {
          file: "vendor-pkg/index.js",
          line: 2,
          severity: "high",
          category: "security",
          title: "Unvalidated command execution via child_process.exec",
          detail: "exports.run passes untrusted cmd directly to child_process.exec.",
          suggestion: "Use execFile with fixed command and argument array."
        }
      ],
      files_reviewed: 1
    }
  }
};
process.stdout.write(JSON.stringify(event) + "\\n");
`,
      { encoding: "utf8", mode: 0o755 },
    );

    const ghOut = join(workDir, "audit_out.txt");
    const stepSummary = join(workDir, "step_summary.md");
    writeFileSync(ghOut, "", "utf8");
    writeFileSync(stepSummary, "", "utf8");

    const code = await runPrReview(
      {
        PATH: process.env.PATH,
        PI_BIN: fakePi,
        ACTION_ROOT: rootDir,
        RUNNER_TEMP: workDir,
        GITHUB_OUTPUT: ghOut,
        GITHUB_STEP_SUMMARY: stepSummary,
        PI_SUPPRESS_GH_ANNOTATIONS: "1",
        INPUT_DEFAULT_PROMPT_FILE: ".github/prompts/security-audit.md",
        INPUT_AUDIT_MODE: "codebase",
        INPUT_TARGET_PATH: "vendor-pkg",
        INPUT_REPORT_TITLE: "Pi Agent 第三方代码安全审计",
        INPUT_COMMENT_MARKER: "pi-security-audit",
        INPUT_PROVIDER: "openai",
        INPUT_MODEL: "gpt-4o",
        INPUT_API_KEY: "test-fake-api-key-value",
        INPUT_FAIL_ON: "high",
        INPUT_LINK_ISSUES: "false",
        INPUT_POST_COMMENT: "false",
      },
      { cwd: workDir },
    );

    expect(code).toBe(ExitCode.GateFailed);
    const summaryMd = readFileSync(stepSummary, "utf8");
    expect(summaryMd).toContain("<!-- pi-security-audit:begin -->");
    expect(summaryMd).toContain("## Pi Agent 第三方代码安全审计");
    expect(summaryMd).toContain("Unvalidated command execution via child_process.exec");

    const ghOutText = readFileSync(ghOut, "utf8");
    expect(ghOutText).toContain(`exit_code=${ExitCode.GateFailed}`);
    expect(ghOutText).toContain("findings_count=1");
    expect(ghOutText).toContain("pi-security-audit-context");

    const auditReportPath = join(
      workDir,
      "pi-security-audit-context/report.json",
    );
    expect(existsSync(auditReportPath)).toBe(true);
    const reportJson = JSON.parse(readFileSync(auditReportPath, "utf8"));
    expect(reportJson.verdict).toBe("request_changes");
    expect(reportJson.findings[0].category).toBe("security");
    expect(reportJson.findings[0].severity).toBe("high");
  });
});
