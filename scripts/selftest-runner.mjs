#!/usr/bin/env node
/**
 * Action 核心模块的自动化自测套件（无需外部网络或 API Key）
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildChildEnv,
  buildPiInvocation,
  isShellToolEnabled,
  parseContextFiles,
  resolveTextOrFile,
  runAgent,
} from "./run-agent.mjs";
import { setupPiConfig } from "./setup-pi-config.mjs";
import { extractJsonReport, normalizeReport } from "./pr-review/render-comment.mjs";
import { findMatchingComment, publishComment } from "./pr-review/publish-comment.mjs";

async function main() {
  const workDir = mkdtempSync(join(tmpdir(), "agentic-action-test-"));

  try {
    // 1. 测试 setupPiConfig：深度合并 settings.json 且不创建 AGENTS.md
    {
      const fakeAgentDir = join(workDir, "pi-agent");
      mkdirSync(fakeAgentDir, { recursive: true });
      writeFileSync(
        join(fakeAgentDir, "settings.json"),
        JSON.stringify({ customSetting: "keep-me" }),
        "utf8",
      );

      const res = setupPiConfig({ actionPath: process.cwd(), agentDir: fakeAgentDir });
      const merged = JSON.parse(readFileSync(res.settingsPath, "utf8"));
      assert.equal(merged.customSetting, "keep-me", "应保留用户原有的 settings.json 字段");
      assert.equal(merged.defaultProjectTrust, "always", "应注入 defaultProjectTrust: always");
      assert.ok(res.installedExtensions.includes("ci-logger.ts"), "应同步 ci-logger.ts");
      assert.equal(existsSync(join(fakeAgentDir, "AGENTS.md")), false, "不应注入全局 AGENTS.md");
    }

    // 2. 测试 resolveTextOrFile 与 parseContextFiles（含空格文件名、换行/逗号分隔）
    {
      const promptFile = join(workDir, "my prompt.md");
      writeFileSync(promptFile, "prompt from file", "utf8");
      const fileA = join(workDir, "file with space.txt");
      const fileB = join(workDir, "b.txt");
      writeFileSync(fileA, "a", "utf8");
      writeFileSync(fileB, "b", "utf8");

      assert.equal(resolveTextOrFile("my prompt.md", workDir), "prompt from file");
      assert.equal(resolveTextOrFile("- inline dash prompt", workDir), "- inline dash prompt");

      const ctxComma = parseContextFiles("file with space.txt, b.txt, missing.txt", workDir);
      assert.deepEqual(ctxComma, ["@file with space.txt", "@b.txt"]);
    }

    // 3. 测试 buildPiInvocation：--api-key 脱敏与 `--` 选项终止符
    {
      const { args, redactedArgs } = buildPiInvocation(
        {
          prompt: "- starts with dash",
          model: "gpt-4o",
          provider: "openai",
          apiKey: "sk-secret-12345",
          tools: "read,grep",
        },
        workDir,
      );
      assert.ok(args.includes("sk-secret-12345"));
      assert.ok(!redactedArgs.includes("sk-secret-12345"), "redactedArgs 严禁包含明文 apiKey");
      assert.ok(redactedArgs.includes("***"), "redactedArgs 应将 apiKey 脱敏为 ***");
      const dashIdx = args.indexOf("--");
      assert.ok(dashIdx !== -1 && args[dashIdx + 1] === "- starts with dash", "应使用 -- 保护以短横线开头的 prompt");
    }

    // 4. 测试工具权限与 GH_TOKEN 剥离逻辑
    {
      assert.equal(isShellToolEnabled({ tools: "read,grep,find,ls" }), false);
      assert.equal(isShellToolEnabled({ tools: "read,bash" }), true);
      assert.equal(isShellToolEnabled({ noTools: "true", tools: "bash" }), false);
      assert.equal(isShellToolEnabled({ excludeTools: "bash,powershell" }), false);

      const envReadonly = buildChildEnv(
        { GH_TOKEN: "ghs_secret", GITHUB_TOKEN: "ghs_secret2", PATH: "/usr/bin" },
        { tools: "read,grep,find,ls" },
      );
      assert.equal(envReadonly.GH_TOKEN, undefined, "只读工具模式下必须剥离 GH_TOKEN");
      assert.equal(envReadonly.GITHUB_TOKEN, undefined, "只读工具模式下必须剥离 GITHUB_TOKEN");

      const envWithBash = buildChildEnv(
        { GH_TOKEN: "ghs_secret", PATH: "/usr/bin" },
        { tools: "read,bash" },
      );
      assert.equal(envWithBash.GH_TOKEN, "ghs_secret", "允许 bash 时应保留 GH_TOKEN");
    }

    // 5. 测试 runAgent 端到端（使用模拟的 pi 可执行脚本）
    {
      const fakePi = join(workDir, "fake-pi.mjs");
      writeFileSync(
        fakePi,
        `#!/usr/bin/env node
console.log(JSON.stringify({ argv: process.argv.slice(2), hasGhToken: Boolean(process.env.GH_TOKEN) }));
`,
        { encoding: "utf8", mode: 0o755 },
      );
      const ghOutput = join(workDir, "github_output.txt");
      const ghSummary = join(workDir, "github_summary.md");
      writeFileSync(ghOutput, "", "utf8");
      writeFileSync(ghSummary, "", "utf8");

      const { exitCode, output, resultFile } = await runAgent(
        {
          prompt: "hello world",
          model: "test-model",
          tools: "read,grep",
        },
        {
          piBin: fakePi,
          cwd: workDir,
          env: {
            ...process.env,
            GH_TOKEN: "should-be-stripped",
            RUNNER_TEMP: workDir,
            GITHUB_OUTPUT: ghOutput,
            GITHUB_STEP_SUMMARY: ghSummary,
          },
        },
      );
      assert.equal(exitCode, 0);
      const parsed = JSON.parse(output.trim());
      assert.equal(parsed.hasGhToken, false, "fake-pi 子进程不应收到 GH_TOKEN");
      assert.ok(existsSync(resultFile));
      const outputContent = readFileSync(ghOutput, "utf8");
      assert.ok(outputContent.includes("exit_code=0"));
      assert.ok(outputContent.includes("result_file="));
    }

    // 6. 测试 extractJsonReport：支持 Markdown 代码块与前后散文包裹的 JSON 提取
    {
      const wrapped = `
我已经完成了对所有 chunk 的审查，以下是结构化结果：

\`\`\`json
{
  "summary": "发现 1 个安全问题",
  "verdict": "request_changes",
  "coverage": { "chunks_reviewed": [1], "chunks_total": 1, "files_reviewed": 2, "files_total": 2 },
  "findings": [
    { "file": "src/a.ts", "line": 10, "severity": "high", "category": "security", "title": "注入风险", "detail": "详情", "suggestion": "修复" }
  ]
}
\`\`\`
`;
      const extracted = extractJsonReport(wrapped);
      assert.equal(extracted.verdict, "request_changes");
      const normalized = normalizeReport(wrapped);
      assert.equal(normalized.findings.length, 1);
      assert.equal(normalized.findings[0].severity, "high");
    }

    // 7. 测试 publishComment：按 HTML marker 精确命中与更新，不误伤其他 bot 评论
    {
      const mockComments = [
        { id: 101, body: "<!-- pi-review:begin -->\nold review\n<!-- pi-review:end -->" },
        { id: 202, body: "Some other github-actions[bot] coverage comment without marker" },
      ];
      const matched = findMatchingComment(mockComments, "pi-review");
      assert.equal(matched?.id, 101, "必须精确匹配带 pi-review marker 的评论 #101，而不是最后一条 #202");

      const calls = [];
      const mockFetch = async (url, init) => {
        calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
        if (init.method === "GET") {
          return { ok: true, json: async () => mockComments };
        }
        return { ok: true, json: async () => ({ id: 101, html_url: "https://example.com/comment/101" }) };
      };

      const pubRes = await publishComment({
        repo: "devcxl/agentic-action",
        pr: "42",
        body: "<!-- pi-review:begin -->\nnew review\n<!-- pi-review:end -->",
        marker: "pi-review",
        token: "fake-token",
        fetchImpl: mockFetch,
      });
      assert.equal(pubRes.action, "updated");
      assert.equal(pubRes.commentId, 101);
      assert.equal(calls.length, 2);
      assert.equal(calls[1].method, "PATCH");
      assert.ok(calls[1].url.endsWith("/issues/comments/101"));
    }

    // 8. 测试 runPrReview 全链路（真实 git 仓库 + 模拟 Pi 输出 + 模拟 GitHub API 回评 + 门禁判定）
    {
      const repoDir = join(workDir, "mock-pr-repo");
      mkdirSync(join(repoDir, "src"), { recursive: true });
      const { execFileSync } = await import("node:child_process");
      const git = (args) => execFileSync("git", args, { cwd: repoDir, stdio: "ignore" });
      git(["init", "-q"]);
      git(["config", "user.email", "test@example.com"]);
      git(["config", "user.name", "test"]);
      git(["checkout", "-q", "-b", "main"]);
      writeFileSync(join(repoDir, "src/index.ts"), "export const x = 1;\n", "utf8");
      git(["add", "-A"]);
      git(["commit", "-qm", "base"]);
      const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();

      writeFileSync(join(repoDir, "src/index.ts"), "export const x = 2;\nexport const y = eval('1');\n", "utf8");
      git(["add", "-A"]);
      git(["commit", "-qm", "head"]);

      const fakePi = join(workDir, "fake-pi-review.mjs");
      writeFileSync(
        fakePi,
        `#!/usr/bin/env node
console.log(\`Here is the review report:
\\\`\\\`\\\`json
{
  "summary": "Found eval usage",
  "verdict": "request_changes",
  "coverage": { "chunks_reviewed": [1], "chunks_total": 1, "files_reviewed": 1, "files_total": 1 },
  "findings": [
    { "file": "src/index.ts", "line": 2, "severity": "high", "category": "security", "title": "Avoid eval", "detail": "eval is unsafe", "suggestion": "Remove eval" }
  ]
}
\\\`\\\`\\\`\`);
`,
        { encoding: "utf8", mode: 0o755 },
      );

      const prOutput = join(workDir, "pr_github_output.txt");
      const prSummary = join(workDir, "pr_github_summary.md");
      writeFileSync(prOutput, "", "utf8");
      writeFileSync(prSummary, "", "utf8");

      const prevCwd = process.cwd();
      process.chdir(repoDir);
      try {
        const { runPrReview } = await import("./pr-review/run-review.mjs");
        const gateCode = await runPrReview({
          ...process.env,
          PI_BIN: fakePi,
          RUNNER_TEMP: workDir,
          GITHUB_OUTPUT: prOutput,
          GITHUB_STEP_SUMMARY: prSummary,
          INPUT_MODEL: "test-model",
          INPUT_API_KEY: "test-key",
          INPUT_BASE_SHA: baseSha,
          INPUT_PR_NUMBER: "99",
          INPUT_FAIL_ON: "high",
          INPUT_POST_COMMENT: "false",
        });
        assert.equal(gateCode, 1, "发现 high 级别问题且 fail_on=high 时应返回门禁码 1");
        const outText = readFileSync(prOutput, "utf8");
        assert.ok(outText.includes("verdict=request_changes"));
        assert.ok(outText.includes("findings_count=1"));
        // 验证工作区未被 .review-context 污染
        assert.equal(existsSync(join(repoDir, ".review-context")), false, "不应在工作区内生成 .review-context");
      } finally {
        process.chdir(prevCwd);
      }
    }

    console.log("selftest-runner: 全部单元测试通过");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
