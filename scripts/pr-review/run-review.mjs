#!/usr/bin/env node
/**
 * PR 审查全链路编排器
 *
 * 核心流程：
 * 1. 解析 PR 编号与 base commit SHA（若本地缺失则按 SHA 补拉）。
 * 2. 在工作区外（默认 ${RUNNER_TEMP}/pi-review-context）构建本地 git merge-base 审查上下文，
 *    避免 `.review-context/base/` 污染工作区、避免干扰 Agent 的 grep/find。
 * 3. 检查模型凭据是否就绪（支持 fork PR 无凭据优雅降级，只验证上下文生成）。
 * 4. 以纯只读工具集（read,grep,find,ls）且剥离 GH_TOKEN 的方式运行 Pi Agent。
 * 5. 从 Agent 响应（或兼容的 report.json）中提取并归一化结构化报告，渲染 PR 评论 Markdown。
 * 6. 若开启 post_comment 且存在有效凭据，按 HTML marker 精确更新/创建 PR 评论。
 * 7. 写出 GitHub Outputs 与 Step Summary，并在最后执行 fail_on 门禁判定。
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runAgent, writeGitHubOutput, writeStepSummary } from "../run-agent.mjs";
import { publishComment } from "./publish-comment.mjs";
import { normalizeReport } from "./render-comment.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");

const log = (msg) => console.error(`[pr-review] ${msg}`);

function execCmd(bin, args, { cwd = process.cwd(), env = process.env, allowFail = false } = {}) {
  try {
    return execFileSync(bin, args, {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (allowFail) return "";
    const stderr = error.stderr ? String(error.stderr).trim() : "";
    throw new Error(`${bin} ${args.join(" ")} 失败: ${stderr || error.message}`);
  }
}

/**
 * 判断当前环境中是否存在可用的模型 API Key
 */
export function hasModelCredentials(inputs, env = process.env) {
  if (inputs.apiKey && inputs.apiKey.trim()) return true;
  const knownEnvKeys = [
    "HALF_CABBAGE_API_KEY",
    "HALF_CABBAGE_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_OAUTH_TOKEN",
    "GEMINI_API_KEY",
    "DEEPSEEK_API_KEY",
    "OPENROUTER_API_KEY",
    "GROQ_API_KEY",
    "MISTRAL_API_KEY",
    "MINIMAX_API_KEY",
    "MOONSHOT_API_KEY",
    "ZAI_API_KEY",
    "ZAI_CODING_CN_API_KEY",
    "QWEN_TOKEN_PLAN_API_KEY",
    "QWEN_TOKEN_PLAN_CN_API_KEY",
    "XIAOMI_API_KEY",
    "KIMI_API_KEY",
    "OPENCODE_API_KEY",
    "AI_GATEWAY_API_KEY",
    "CLOUDFLARE_API_KEY",
    "AWS_BEARER_TOKEN_BEDROCK",
    "AWS_SECRET_ACCESS_KEY",
  ];
  return knownEnvKeys.some((k) => Boolean(env[k] && String(env[k]).trim()));
}

/**
 * 解析并确保本地拥有 base commit
 */
export function resolveBaseSha({ baseSha, prNumber, cwd = process.cwd(), env = process.env }) {
  let resolved = (baseSha || "").trim();
  if (!resolved && env.GITHUB_EVENT_PATH && existsSync(env.GITHUB_EVENT_PATH)) {
    try {
      const ev = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
      resolved = ev?.pull_request?.base?.sha || "";
    } catch {
      // ignore
    }
  }
  if (!resolved && prNumber) {
    resolved = execCmd("gh", ["pr", "view", String(prNumber), "--json", "baseRefOid", "--jq", ".baseRefOid"], {
      cwd,
      env,
    }).trim();
  }
  if (!resolved) {
    throw new Error("无法确定 base_sha（请传入 base_sha，或在 pull_request 事件中运行，或提供 pr_number）");
  }

  const verify = execCmd("git", ["cat-file", "-e", `${resolved}^{commit}`], {
    cwd,
    env,
    allowFail: true,
  });
  // git cat-file -e 成功返回空字符串，所以我们用 rev-parse --verify 判断是否存在
  const existsLocal = execCmd("git", ["rev-parse", "--verify", "--quiet", `${resolved}^{commit}`], {
    cwd,
    env,
    allowFail: true,
  }).trim();

  if (!existsLocal) {
    log(`base commit ${resolved} 不在本地，正在按 SHA 补取...`);
    execCmd("git", ["fetch", "--no-tags", "origin", resolved], { cwd, env });
  }
  return resolved;
}

export function buildReviewPrompt({ prNumber, contextDir, maxChunks = "0", extraPrompt = "" }) {
  const lines = [
    `执行 PR ${prNumber ? `#${prNumber} ` : ""}的代码审查。`,
    "",
    `审查上下文目录（<CONTEXT_DIR>）位于：\`${contextDir}\``,
    "",
    `1. 读取 \`${join(contextDir, "REVIEW_CONTEXT.md")}\` 与 \`${join(contextDir, "manifest.json")}\`。`,
    `2. 按 manifest 的 chunk 顺序逐个审查 \`${join(contextDir, "patches")}\` 中的 patch；需要对照改动前版本时读取 \`${join(contextDir, "base")}\` 下的对应文件。`,
    "3. 严格按照系统提示词中的输出契约，在最终回复中直接输出纯 JSON 格式的审查报告（不要用无关文字包裹）。",
    "",
    `本次审查最多处理 ${maxChunks || "0"} 个 chunk（0 表示不限）。`,
    "若 chunk 总数超出本次预算，请审查靠前的 chunk 并如实填写 coverage，同时在 summary 中说明剩余未审查的范围。",
    "审查对象是当前工作区（PR head），base 提交见 manifest.json。",
  ];
  if (extraPrompt && extraPrompt.trim()) {
    lines.push("", "## 补充审查要求", "", extraPrompt.trim());
  }
  return lines.join("\n");
}

export async function runPrReview(env = process.env) {
  const cwd = process.cwd();
  const prNumber = (env.INPUT_PR_NUMBER || "").trim();
  const maxChunks = (env.INPUT_MAX_CHUNKS || "0").trim();
  const failOn = (env.INPUT_FAIL_ON || "high").trim();
  const postComment = (env.INPUT_POST_COMMENT || "true").trim() === "true";
  const marker = (env.INPUT_COMMENT_MARKER || "pi-review").trim();
  const extraExclude = (env.INPUT_EXCLUDE || "").trim();

  const tempBase = env.RUNNER_TEMP || tmpdir();
  const contextDir = env.INPUT_CONTEXT_DIR
    ? resolve(cwd, env.INPUT_CONTEXT_DIR)
    : join(tempBase, "pi-review-context");
  mkdirSync(contextDir, { recursive: true });

  const baseSha = resolveBaseSha({
    baseSha: env.INPUT_BASE_SHA,
    prNumber,
    cwd,
    env,
  });

  // 1. 生成本地 diff 审查上下文
  const buildArgs = [
    join(REPO_ROOT, "scripts/pr-review/build-context.mjs"),
    "--base",
    baseSha,
    "--out",
    contextDir,
    "--base-snapshot",
    "--max-chunk-lines",
    env.INPUT_MAX_CHUNK_LINES || "1500",
    "--max-chunk-bytes",
    env.INPUT_MAX_CHUNK_BYTES || "40960",
    "--max-file-bytes",
    env.INPUT_MAX_FILE_BYTES || "409600",
  ];
  if (extraExclude) {
    buildArgs.push("--exclude", extraExclude);
  }
  execFileSync(process.execPath, buildArgs, {
    cwd,
    env,
    stdio: ["ignore", "inherit", "inherit"],
  });

  const reportFile = join(contextDir, "report.json");
  const commentFile = join(contextDir, "review-comment.md");
  const rawResultFile = join(contextDir, "pi-raw-output.txt");

  // 2. 检查模型凭据（兼容无 secrets 的 fork PR）
  const credsAvailable = hasModelCredentials(
    { apiKey: env.INPUT_API_KEY },
    env,
  );
  if (!credsAvailable) {
    console.log("::notice::未检测到模型 API Key（可能是 fork PR 或未配置密钥），跳过模型审查与回评（本地审查上下文已生成）");
    writeGitHubOutput(
      {
        context_dir: contextDir,
        report_file: "",
        comment_file: "",
        verdict: "skipped",
        findings_count: "0",
        exit_code: "0",
      },
      env.GITHUB_OUTPUT,
    );
    return 0;
  }

  // 3. 组装只读安全参数运行 Pi
  const defaultReviewPromptPath = join(REPO_ROOT, ".github/prompts/pr-review.md");
  const userAppendPrompt = (env.INPUT_APPEND_SYSTEM_PROMPT || "").trim();
  let combinedAppendPrompt = readFileSync(defaultReviewPromptPath, "utf8");
  if (userAppendPrompt) {
    const extraText = existsSync(resolve(cwd, userAppendPrompt))
      ? readFileSync(resolve(cwd, userAppendPrompt), "utf8")
      : userAppendPrompt;
    combinedAppendPrompt = `${combinedAppendPrompt}\n\n${extraText}`;
  }

  const reviewPrompt = buildReviewPrompt({
    prNumber,
    contextDir,
    maxChunks,
    extraPrompt: env.INPUT_PROMPT || "",
  });

  const agentInputs = {
    prompt: reviewPrompt,
    systemPrompt: env.INPUT_SYSTEM_PROMPT || "",
    appendSystemPrompt: combinedAppendPrompt,
    contextFiles: env.INPUT_CONTEXT_FILES || "",
    promptTemplate: env.INPUT_PROMPT_TEMPLATE || "",
    model: env.INPUT_MODEL || "",
    provider: env.INPUT_PROVIDER || "",
    thinking: env.INPUT_THINKING || "high",
    apiKey: env.INPUT_API_KEY || "",
    // 默认仅开启纯只读工具，彻底杜绝写文件与命令执行风险
    tools: env.INPUT_TOOLS || "read,grep,find,ls",
    excludeTools: env.INPUT_EXCLUDE_TOOLS || "",
    noBuiltinTools: "false",
    noTools: "false",
    mode: "text",
    resultFile: rawResultFile,
    writeSummary: "false",
  };

  const { exitCode: piExitCode } = await runAgent(agentInputs, {
    piBin: env.PI_BIN || process.env.PI_BIN || "pi",
    cwd,
    env,
  });

  // 4. 提取报告并渲染 Markdown 评论
  // 优先检查是否有直接落盘的 report.json，否则从 Pi 的 stdout (rawResultFile) 中提取 JSON
  const reportSource = existsSync(reportFile) ? reportFile : rawResultFile;
  let gateExitCode = 0;
  let verdict = "error";
  let findingsCount = 0;

  try {
    if (piExitCode !== 0 && !existsSync(reportSource)) {
      throw new Error(`Pi 进程异常退出 (code ${piExitCode})`);
    }
    const rawContent = existsSync(reportSource) ? readFileSync(reportSource, "utf8") : "";
    const normalized = normalizeReport(rawContent);
    verdict = normalized.verdict;
    findingsCount = normalized.findings.length;

    try {
      execFileSync(
        process.execPath,
        [
          join(REPO_ROOT, "scripts/pr-review/render-comment.mjs"),
          "--report",
          reportSource,
          "--extract-out",
          reportFile,
          "--out",
          commentFile,
          "--fail-on",
          failOn,
          "--marker",
          marker,
        ],
        { cwd, env, stdio: ["ignore", "pipe", "inherit"] },
      );
      gateExitCode = 0;
    } catch (renderErr) {
      gateExitCode = renderErr.status ?? 2;
      if (gateExitCode !== 1) throw renderErr;
    }
  } catch (err) {
    log(`未能解析结构化审查报告: ${err.message}`);
    const fallbackMd = [
      `<!-- ${marker}:begin -->`,
      "## Pi Agent 代码审查",
      "",
      "本次运行未能产出结构化审查结果（Agent 未按契约返回有效 JSON 报告）。",
      "请查看本次运行的日志与上传的 artifact。",
      `<!-- ${marker}:end -->`,
      "",
    ].join("\n");
    writeFileSync(commentFile, fallbackMd, "utf8");
    gateExitCode = 2;
  }

  const commentMarkdown = existsSync(commentFile) ? readFileSync(commentFile, "utf8") : "";
  if (commentMarkdown) {
    writeStepSummary(commentMarkdown, "text", env.GITHUB_STEP_SUMMARY);
  }

  // 5. 幂等发布 PR 评论（在门禁退出之前发布，确保发现严重问题时评论已留在 PR 上）
  const githubToken = env.INPUT_GITHUB_TOKEN || env.GH_TOKEN || env.GITHUB_TOKEN;
  const repo = env.GITHUB_REPOSITORY || "";
  if (postComment && prNumber && repo && githubToken && commentMarkdown) {
    try {
      await publishComment({
        repo,
        pr: prNumber,
        body: commentMarkdown,
        marker,
        token: githubToken,
      });
    } catch (pubErr) {
      log(`发布 PR 评论失败: ${pubErr.message}`);
    }
  }

  writeGitHubOutput(
    {
      context_dir: contextDir,
      report_file: existsSync(reportFile) ? reportFile : "",
      comment_file: existsSync(commentFile) ? commentFile : "",
      result: commentMarkdown.trim(),
      result_file: existsSync(commentFile) ? commentFile : rawResultFile,
      verdict,
      findings_count: String(findingsCount),
      exit_code: String(gateExitCode),
    },
    env.GITHUB_OUTPUT,
  );

  if (gateExitCode === 1) {
    const prefix = env.PI_SUPPRESS_GH_ANNOTATIONS === "1" ? "[pr-review]" : "::error::";
    console.error(`${prefix}审查发现达到或高于 ${failOn} 级别的问题，详见 PR 评论`);
  } else if (gateExitCode !== 0) {
    const prefix = env.PI_SUPPRESS_GH_ANNOTATIONS === "1" ? "[pr-review]" : "::error::";
    console.error(`${prefix}审查未能产出有效结构化报告，请检查运行日志`);
  }
  return gateExitCode;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runPrReview(process.env)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      log(`错误: ${error.message}`);
      process.exitCode = 1;
    });
}
