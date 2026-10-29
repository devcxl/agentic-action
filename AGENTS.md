# AGENTS.md

本文件为在本仓库中工作的编码代理（pi / Claude Code / OpenCode 等）提供指引。

## 这是什么

一个 GitHub Composite Action 套件（不是可发布的 npm 库）。仓库内同时包含四个消费者入口：根 `action.yml`、`pr-review/`、`security-audit/`、`triage/`，共用同一套 TypeScript 源码与 `dist/` 打包产物。

## 命令

```bash
pnpm install --frozen-lockfile   # CI 用 pnpm 10 + Node 22，lockfileVersion 9.0
pnpm typecheck                   # tsc --noEmit，覆盖 packages/*/src 与 tests
pnpm build                       # 用 esbuild 重建 dist/*.js（产物已提交）
pnpm build:check                 # 断言 dist/ 与源码一致
pnpm test                        # vitest run
```

**存在强制顺序**，CI（`.github/workflows/pr-review-selftest.yml`）与 Release 都是这个顺序：

```
pnpm typecheck → pnpm build:check → pnpm test
```

- 改动 `packages/actions/src/*`（四个入口之一）后必须先 `pnpm build` 再 `pnpm test`。
- `tests/dist-entrypoints.test.ts` 直接 `execFileSync` 执行 `dist/*.js`。忘了重建 `dist/` 时该测试会跑**旧产物**并通过，同时 CI 的 `build:check` 失败。改入口逻辑时务必先 build。

聚焦单个测试（vitest 语法，路径相对仓库根）：

```bash
./node_modules/.bin/vitest run tests/review-pipeline.test.ts
./node_modules/.bin/vitest run tests/triage-and-linkage.test.ts -t "planReviewPolicy"
```

`node_modules` 由 pnpm 10 安装；若本地 pnpm 版本更高，`pnpm <script>` 会因版本不匹配触发重装检查而失败（`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`）。此时直接用 `./node_modules/.bin/tsc --noEmit`、`./node_modules/.bin/vitest run`、`node scripts/build-dist.mjs --check`，它们与上面的脚本一一对应。

## 架构与包边界

```
packages/contracts   纯类型 + ExitCode 常量，零 IO、零依赖
packages/core        纯函数领域逻辑（capability/review/triage）
packages/adapters    IO：git / pi 子进程 / GitHub / TypeSafe / workspace / log
packages/actions     用例编排 + 四个 CLI 入口
packages/extensions  pi 运行时扩展（TS 源码，运行时复制给 pi）
```

- 依赖方向：`actions → core + adapters + contracts`，`adapters → core + contracts`，`core → contracts`。
- **`packages/core` 与 `packages/contracts` 禁止 `import "node:*"`**（当前 grep 结果为 0）。这是 `docs/architecture-v2.md` 原则 4 的落地条件：核心层保持纯函数才可被单测 100% 覆盖，需要 IO 时把端口定义在 core、实现放 `adapters`。
- 包之间不经过构建产物：`main` 指向 `src/index.ts`，导入通过 `tsconfig.json` 的 `paths` 与 `vitest.config.ts` 的 `alias` 映射到 `packages/*/src/index.ts`。新增包必须同时改这两处。
- 入口与产物由 `scripts/build-dist.mjs` 的 `ENTRYPOINTS` 表决定，一一对应：

  | 源码 | 产物 | 消费者 |
  | --- | --- | --- |
  | `packages/actions/src/run-agent.ts` | `dist/run-agent.js` | 根 `action.yml` |
  | `packages/actions/src/review-pr.ts` | `dist/review-pr.js` | `pr-review/` **和** `security-audit/` |
  | `packages/actions/src/triage-issue.ts` | `dist/triage-issue.js` | `triage/` |
  | `packages/actions/src/setup-pi-config.ts` | `dist/setup-pi-config.js` | 根、`pr-review/`、`security-audit/` 的配置步骤 |

- `security-audit` 没有独立 bundle：它执行 `dist/review-pr.js`，靠 `INPUT_SECURITY_AUDIT=true`、`audit_mode`、`target_path`、`default_prompt_file`、`report_title`、`comment_marker` 分支到 codebase 快照审计。改 review 管线时要同时考虑审计路径。

### dist/ 与 extensions 的两种分发方式

- `dist/*.js` 是 esbuild 单文件 ESM 打包并**提交进 git**（`git ls-files dist` 可见四项）。消费者运行 action 时不安装依赖。**不要手改 `dist/`**，只改源码后 `pnpm build`。
- `packages/extensions/src/*.ts` 不打进 dist：`dist/setup-pi-config.js` 在运行时把它们**按源码复制**到 `$PI_CODING_AGENT_DIR/extensions/`（`index.ts`、`*.d.ts`、`submit-review.ts` 除外）。所以改扩展不需要重建 dist，但改 `setup-pi-config.ts` 需要。
- `submit-review.ts` 只在审查/审计时通过 pi 的 `-e <path>` 显式加载，不进全局扩展目录（避免工具名冲突）。

### 一次 action 运行的装配顺序

三个启动 pi 的 action 步骤完全同构：`actions/setup-node@v4`（node 22）→ `scripts/setup-pi-cli.sh`（按 `PI_VERSION` 装到 `~/.pi-cli`，带 GitHub Actions cache）→ `node dist/setup-pi-config.js`（写 `settings.json` + 复制扩展）→ `node dist/<entry>.js`（读取 `INPUT_*`）。要改 pi 版本默认值，需同时改 `action.yml` 的 `pi_version` 与 `scripts/setup-pi-cli.sh` 的 `PI_VERSION` 默认值。

## 输入面：新增或修改输入要改多处

三个 action 的输入不是自动透传的，链路是：`action.yml` 的 `inputs:` → 该 step 的 `env:` 逐条映射成 `INPUT_*` → 代码读 `env.INPUT_*`。**新增一个输入必须同时改 `inputs:` 和 `env:` 映射，否则输入会被静默丢弃。**

反方向也存在：代码会读取若干**未在 action.yml 声明**的输入，它们只能由 workflow 的 `env:` 显式提供，用 `with:` 无效——

`INPUT_TIMEOUT_MS`（单次 pi 调用超时；审查侧默认 600000ms、下限 10000ms）、`INPUT_ARTIFACT_DIR`、`INPUT_PR_TITLE`、`INPUT_PR_BODY`、`INPUT_ISSUE_LABELS`、`INPUT_REPOSITORY`。

`action.yml` 里 step 的 `node dist/*.js` 是唯一执行点；`pr-review`/`security-audit` 的 review step 用 `set +e` 吞掉退出码写进 `gate_code` output，再由独立的 `Enforce ... gate` step 用 `case` 分派成 job 退出码。**新增 `ExitCode` 枚举值必须同步修改 `pr-review/action.yml` 与 `security-audit/action.yml` 两份 `case` 分支**，否则新码会落进 `*)` 被当作 30。

## 契约：退出码与结果信封

`packages/contracts/src/result.ts` 定义 `ExitCode`：`0 Ok`、`10 GateFailed`、`20 InvalidReport`、`30 Infrastructure`。这是面向消费者的外部契约，不能复用为其他语义（例如用 `1` 表示失败）。

每个入口都写 `<artifactDir>/result.json`（`RunResult`，`schemaVersion: 2`），同时映射到 `GITHUB_OUTPUT`。机器消费走 outputs / artifact，Step Summary 只放人看的结论。

## 测试怪癖

- 测试不需要网络：`fetch` 通过 `fetchImpl` 参数注入并由测试 mock；pi 子进程用临时目录里的假可执行文件（`PATH` + `PI_BIN`）替代。
- 需要真实 `git` 在 `PATH` 上：`review-pipeline`、`capability-and-security`、`snapshot-inventory` 等会在 `mkdtemp` 目录里真跑 `git init` / commit / clone。
- `tests/dist-entrypoints.test.ts` 会读取**仓库真实的** `.github/triage.yml` 并断言 `model === "jev-1.14.0"`、`fallback === "other"`；改这份配置要同步断言。
- 同一文件还会断言 `setup-pi-config` 装进全局 agentDir 的扩展清单（`ci-logger.ts` 在、`submit-review.ts` 不在）与 `defaultProjectTrust === "never"`。增删扩展文件会让它失败。
- `tests/*.test.ts` 里的集成用例大多通过 `cwd` + `env` 直接驱动 `runPrReview` / `runIssueTriage` / `runAgent`，不走 action.yml。改输入名要同时改这些环境变量字符串。

## 安全约束（这是产品本身，不是附加项）

被审查仓库的内容是**不可信数据**。以下不变量由测试与文档共同保证，代理改动时不得放宽：

- `packages/core/src/capability/policy.ts` 的 `buildSandboxSpec(policy, hostEnv)` 是子进程 argv 与环境变量的**唯一来源**。不要在别处拼接 pi 参数或自行构造子进程 env。
- 默认 `--no-approve`、`--no-mcp`、`defaultProjectTrust: "never"`（`setup-pi-config.ts` 写死默认值）。
- 子进程环境是严格白名单：基础集 `BASE_SAFE_ENV_KEYS` + 由 `provider`/`model` 推导出的该 provider 密钥名 + `env_allow`。循环里显式跳过 `INPUT_*`、`GITHUB_TOKEN`、`GH_TOKEN`，因此只有 `tools` 含 `bash` 且未设 `no_tools` / `no_builtin_tools` 时才由 `isShellEnabledInPolicy` 注入 `GH_TOKEN`。`TYPESAFE_API_KEY` 不在任何白名单里。
- 启动 pi 前 `git` 适配器会清除 `.git/config` 里残留的 `http.*.extraheader`；发布评论与 Summary 前用 `collectSensitiveValues` / `redactText` 做精确子串脱敏。新增任何输出通道（新 output、新 artifact、新日志）都要经过脱敏。
- 提示词注入防线：`packages/adapters/src/workspace.ts` 给关联 Issue 正文加上 `<!-- UNTRUSTED EXTERNAL CONTENT -->` 标记；关联 Issue 正文默认不注入（`include_issue_body: false`）。新增任何“把仓库/Issue 内容送入模型”的通道都要沿用这个不可信标注。

## 提示词契约有两份副本

审查与审计的系统提示词同时存在于：

1. `.github/prompts/pr-review.md`、`.github/prompts/security-audit.md`
2. `packages/actions/src/review-pr-linkage.ts` 的 `BUILTIN_REVIEW_SYSTEM_PROMPT` / `BUILTIN_SECURITY_AUDIT_SYSTEM_PROMPT`（精简版）

`review-pr-runner.ts` 的选择规则：外部 `ACTION_PATH` 提供的提示词优先；本地检出（`actionRoot === cwd`，即本仓库自己的 workflow `uses: ./pr-review`）**强制使用内置常量**以防 PR 篡改；其余情况读 action 目录里的 `.md`，读不到回退内置。因此改提示词必须两份同时改，否则本地自测与外部消费者行为不一致。

## 协作约定

- `main` 已启用分支保护：只能通过 PR 合并，必需审批数为 0。不要直接 push 到 `main`。
- 发布：push 语义化 tag `vX.Y.Z`（三段式）触发 `.github/workflows/release.yml` 生成 **Draft Release**（不自动发布），并校验 tag 必须等于 `package.json` 的 `version`。当前版本线是 `1.0.0`；`@v1` / `@main` / `@v1.0.0` 都指向当前 v2 架构。
- 仓库自身 workflow 用 `uses: ./pr-review`、`uses: ./security-audit`、`uses: ./triage` 自测（本地 action 路径），外部消费者用 `devcxl/agentic-action/<sub>@v1`。改 `action.yml` 的输入名属于破坏性变更，消费者是按 README 表格对接的。
- 无 lint / formatter / pre-commit 配置；`pnpm typecheck` 是唯一的静态门禁。

## 文档索引

`docs/architecture-v2.md`（分层与契约设计基线）、`docs/triage-design.md`（Jev 分类与 PR 联动）、`docs/large-pr-review.md`（超大 PR 本地比对方案）。README 是面向消费者的输入/环境变量表格，改输入时同步更新。
