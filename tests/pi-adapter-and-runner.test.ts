import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExitCode } from "@agentic-action/contracts";
import { buildSandboxSpec, deriveCapabilityPolicy } from "@agentic-action/core";
import { runPiSubprocess, runPiWithRetry, splitLfLines } from "@agentic-action/adapters";
import { runAgent } from "@agentic-action/actions";

describe("Pi JSONL Event Stream Adapter & Generic Runner v2 (P2)", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "agentic-pi-test-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("splits JSONL strictly on LF without breaking on U+2028 or U+2029", () => {
    const u2028 = "\u2028";
    const u2029 = "\u2029";
    const record = JSON.stringify({
      type: "message_end",
      text: `line1${u2028}line2${u2029}line3`,
    });
    const { lines, remainder } = splitLfLines(`${record}\r\npartial`);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).text).toBe(`line1${u2028}line2${u2029}line3`);
    expect(remainder).toBe("partial");
  });

  it("extracts submit_review structured payload and usage from JSONL stream containing U+2028", async () => {
    const fakePi = join(workDir, "fake-pi-json.mjs");
    writeFileSync(
      fakePi,
      `#!/usr/bin/env node
const u2028 = "\\u2028";
const events = [
  { type: "session", version: 3, id: "s1", timestamp: new Date().toISOString(), cwd: process.cwd() },
  { type: "agent_start" },
  { type: "turn_start" },
  {
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "submit_review",
    result: {
      content: [{ type: "text", text: "ok" }],
      details: {
        summary: "Paragraph A" + u2028 + "Paragraph B",
        verdict: "request_changes",
        findings: [
          {
            file: "src/app.ts",
            line: 12,
            severity: "high",
            category: "security",
            title: "SQL injection",
            detail: "Unsanitized query",
            suggestion: "Use parameterized query"
          }
        ]
      }
    },
    isError: false,
    durationMs: 15
  },
  {
    type: "turn_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Done" }],
      stopReason: "stop",
      usage: {
        input: 120,
        output: 45,
        cacheRead: 10,
        cacheWrite: 0,
        reasoning: 15,
        totalTokens: 165,
        cost: { total: 0.0025 }
      }
    },
    toolResults: []
  },
  { type: "agent_end", messages: [], willRetry: false },
  { type: "agent_settled", aborted: false }
];
for (const ev of events) {
  process.stdout.write(JSON.stringify(ev) + "\\n");
}
`,
      { encoding: "utf8", mode: 0o755 },
    );

    const sandbox = buildSandboxSpec(
      {
        prompt: "review chunk",
        model: "gpt-4o",
        mode: "json",
        policy: deriveCapabilityPolicy({
          tools: "read,submit_review",
          provider: "openai",
          model: "gpt-4o",
        }),
      },
      { PATH: process.env.PATH },
    );

    const res = await runPiSubprocess(sandbox, {
      piBin: fakePi,
      cwd: workDir,
      mode: "json",
    });

    expect(res.exitCode).toBe(0);
    expect(res.settled).toBe(true);
    expect(res.corruptedLines).toBe(0);
    expect(res.usage.inputTokens).toBe(120);
    expect(res.usage.outputTokens).toBe(45);
    expect(res.usage.costTotal).toBe(0.0025);
    expect(res.toolSubmissions.submit_review).toHaveLength(1);
    const sub = res.toolSubmissions.submit_review![0] as { summary: string };
    expect(sub.summary).toBe("Paragraph A\u2028Paragraph B");
  });

  it("handles corrupted JSONL lines and subprocess timeouts cleanly", async () => {
    const fakePiCorrupt = join(workDir, "fake-pi-corrupt.mjs");
    writeFileSync(
      fakePiCorrupt,
      `#!/usr/bin/env node
process.stdout.write("not-valid-json\\n");
process.stdout.write(JSON.stringify({ type: "agent_settled", aborted: false }) + "\\n");
`,
      { encoding: "utf8", mode: 0o755 },
    );

    const sandbox = buildSandboxSpec(
      {
        prompt: "test",
        model: "gpt-4o",
        mode: "json",
        policy: deriveCapabilityPolicy({ tools: "read" }),
      },
      { PATH: process.env.PATH },
    );

    const corruptRes = await runPiSubprocess(sandbox, {
      piBin: fakePiCorrupt,
      cwd: workDir,
      mode: "json",
    });
    expect(corruptRes.corruptedLines).toBe(1);
    expect(corruptRes.settled).toBe(true);

    const fakePiSlow = join(workDir, "fake-pi-slow.mjs");
    writeFileSync(
      fakePiSlow,
      `#!/usr/bin/env node
setTimeout(() => {}, 10000);
`,
      { encoding: "utf8", mode: 0o755 },
    );

    const timeoutRes = await runPiSubprocess(sandbox, {
      piBin: fakePiSlow,
      cwd: workDir,
      mode: "json",
      timeoutMs: 120,
    });
    expect(timeoutRes.timedOut).toBe(true);
    expect(timeoutRes.exitCode).toBe(124);
  });

  it("retries transient upstream 529 errors and succeeds on retry", async () => {
    const stateFile = join(workDir, "attempt.txt");
    const fakePiRetry = join(workDir, "fake-pi-retry.mjs");
    writeFileSync(
      fakePiRetry,
      `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const file = ${JSON.stringify(stateFile)};
const count = existsSync(file) ? Number(readFileSync(file, "utf8")) + 1 : 1;
writeFileSync(file, String(count), "utf8");
if (count === 1) {
  process.stdout.write(JSON.stringify({
    type: "auto_retry_end",
    success: false,
    attempt: 1,
    finalError: "529 Overloaded"
  }) + "\\n");
  process.exit(1);
}
process.stdout.write(JSON.stringify({
  type: "tool_execution_end",
  toolCallId: "c1",
  toolName: "submit_review",
  result: { details: { summary: "ok", verdict: "approve", findings: [] } },
  isError: false
}) + "\\n");
`,
      { encoding: "utf8", mode: 0o755 },
    );

    const sandbox = buildSandboxSpec(
      {
        prompt: "test",
        model: "gpt-4o",
        mode: "json",
        policy: deriveCapabilityPolicy({ tools: "read,submit_review" }),
      },
      { PATH: process.env.PATH },
    );

    const { result, attempts } = await runPiWithRetry(sandbox, {
      piBin: fakePiRetry,
      cwd: workDir,
      mode: "json",
      requiredTool: "submit_review",
      maxRetries: 2,
      sleepImpl: async () => {},
    });

    expect(attempts).toBe(2);
    expect(result.exitCode).toBe(0);
    expect(result.toolSubmissions.submit_review).toHaveLength(1);
  });

  it("runAgent writes result.json, truncates oversized GITHUB_OUTPUT, and maps non-zero exit to ExitCode.Infrastructure", async () => {
    const fakePiBig = join(workDir, "fake-pi-big.mjs");
    writeFileSync(
      fakePiBig,
      `#!/usr/bin/env node
process.stdout.write("A".repeat(40000));
`,
      { encoding: "utf8", mode: 0o755 },
    );

    const ghOutput = join(workDir, "gh_output.txt");
    const ghSummary = join(workDir, "gh_summary.md");
    writeFileSync(ghOutput, "", "utf8");
    writeFileSync(ghSummary, "", "utf8");

    const okRun = await runAgent(
      {
        prompt: "generate long output",
        model: "gpt-4o",
        provider: "openai",
        tools: "read",
      },
      {
        piBin: fakePiBig,
        cwd: workDir,
        streamToStdout: false,
        env: {
          ...process.env,
          RUNNER_TEMP: workDir,
          GITHUB_OUTPUT: ghOutput,
          GITHUB_STEP_SUMMARY: ghSummary,
        },
      },
    );

    expect(okRun.exitCode).toBe(ExitCode.Ok);
    expect(existsSync(okRun.resultFile)).toBe(true);
    expect(readFileSync(okRun.resultFile, "utf8").length).toBe(40000);
    expect(existsSync(okRun.envelopeFile)).toBe(true);
    const outContent = readFileSync(ghOutput, "utf8");
    expect(outContent).toContain("...(truncated, see result_file)");
    expect(outContent).toContain("exit_code=0");

    // Non-zero exit -> ExitCode.Infrastructure (30)
    const fakePiFail = join(workDir, "fake-pi-fail.mjs");
    writeFileSync(
      fakePiFail,
      `#!/usr/bin/env node
process.exit(2);
`,
      { encoding: "utf8", mode: 0o755 },
    );

    const failRun = await runAgent(
      {
        prompt: "fail",
        model: "gpt-4o",
      },
      {
        piBin: fakePiFail,
        cwd: workDir,
        env: {
          ...process.env,
          RUNNER_TEMP: workDir,
        },
      },
    );
    expect(failRun.exitCode).toBe(ExitCode.Infrastructure);
  });
});
