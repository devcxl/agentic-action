# v2 架构设计

本文是 v2 重写的设计基线：先记录 v1 的真实问题（带代码位置），再给出目标架构、模块边界、契约与分阶段迁移路线。v2 的判定标准不是"代码更漂亮"，而是**安全默认正确、输出契约可验证、失败语义明确、可局部替换**。

Issue 自动分类与 PR 审查联动的设计见 [triage-design.md](./triage-design.md)。

---

## 1. v1 诊断

v1 的代码量并不大（13 个文件，3323 行，最大单文件 470 行），问题不在规模，而在**边界放错了**：领域逻辑、进程编排、GitHub 契约、模型输出契约被揉进同一批脚本，于是每一层都无法独立演进或验证。

### 1.1 契约类问题（最严重）

| # | 问题 | 位置 | 影响 |
| - | --- | --- | --- |
| C1 | **退出码语义冲突**：`run-review.mjs` 外层 catch 返回 1，与门禁命中的 1 撞码（`render-comment.mjs:294` 自身异常返回 2，但未能覆盖上游崩溃） | `scripts/pr-review/run-review.mjs:364`（catch → `exitCode = 1`）与 `render-comment.mjs` 的 fail-on=1 | 调用方无法区分"审查发现问题"与"流水线自身坏了"，两者都表现为 job 失败，无法自动告警到正确的人 |
| C2 | **靠正则/括号扫描从散文里抠 JSON** | `render-comment.mjs:69-158` `extractJsonReport` | 模型输出只要多写一句解释就要退化成 fallback 评论；契约靠模型自觉，不靠工具约束 |
| C3 | **预算只写进提示词，代码不执行** | `run-review.mjs:122-140`（`maxChunks` 仅拼入 prompt） | `max_chunks` 对实际成本零约束，模型可以审完全部 chunk，也可以一个都不审 |
| C4 | **评论发布有静默上限** | `publish-comment.mjs:97` `page <= 10` | 超过 1000 条评论的 PR 会找不到既有 marker 评论，重复创建；且无重试/退避/429 处理 |
| C5 | **`cat-file -e` 死代码** | `run-review.mjs:103-107` | 返回值未使用，实际靠下一行 `rev-parse` 判断；每次多跑一个无用的 git 子进程，注释也误导 |
| C6 | **输入面重复且漂移**：composite action 必须手写 `INPUT_*` 映射；`INPUT_CONTEXT_DIR` 在代码里被读取（`run-review.mjs:152`）但 `pr-review/action.yml` 从未声明 | 两个 `action.yml` | 加一个输入要改 3 处；已有隐藏输入/幽灵输入 |

### 1.2 安全类问题

| # | 问题 | 位置 | 影响 |
| - | --- | --- | --- |
| S1 | **无条件信任项目本地配置**：`--approve` + `defaultProjectTrust: "always"` | `run-agent.mjs:103`、`setup-pi-config.mjs:47`、`pi-config/settings.json` | 被审查的 PR 工作区里只要放 `.pi/extensions/*.ts`，就会以 Runner 权限执行任意代码。这与 pr-review"只读、无 bash"的宣称直接冲突 |
| S2 | **凭据仍在只读工具可达范围内**：环境变量仅用黑名单删 `GH_TOKEN`/`GITHUB_TOKEN`；且 checkout 默认把 `GITHUB_TOKEN` 写入 `.git/config` | `run-agent.mjs:166-167`、`.github/workflows/pr-review.yml:43`（未设 `persist-credentials: false`） | `INPUT_GITHUB_TOKEN`、`INPUT_API_KEY` 仍在子进程环境里（`read` 可读 `/proc/self/environ`）；`read` 也能直接读 `.git/config` 里的 token，再借审查评论外带 |
| S3 | **能力判定与执行裁决分离**：`isShellToolEnabled` 猜测 pi 会开哪些工具，再据此决定是否保留 token | `run-agent.mjs:76-100` | 判定和 `--tools` / `--no-builtin-tools` 的真实语义分属两套逻辑（pi CLI 文档 `cli.md` 明确两者可组合覆盖），一旦不一致就是"以为没 bash、其实有 bash" |

### 1.3 工程性缺失

- **无依赖清单、无类型检查、无 formal 测试框架**：`scripts/` 下没有 `package.json`，测试是手写 `assert` 的单文件脚本（`selftest-runner.mjs`）；三个扩展（`.ts`）完全没有类型校验与测试，只有运行时才能发现接口漂移。
- **隐式共享状态**：`build-context.mjs:159` 的模块级 `let repoCwd`，使该模块不可重入、无法并行测试。
- **两处复制粘贴的安装/缓存块**：`action.yml` 与 `pr-review/action.yml` 各写一遍 npm 安装 + cache key + PATH，升级 Node/pi 版本必然漂移。
- **单一真相源被复制**：严重级别顺序同时存在于 `render-comment.mjs:19`、`action.yml` 注释、`fail_on` 校验串；provider 密钥名单硬编码 25 项（`run-review.mjs:51`），必然落后于 pi 的 provider registry。
- **单点长跑、无超时拆分**：整份 PR 由单个 pi 进程一次审完，90 分钟 job 超时即全部丢失。

---

## 2. 目标架构

### 2.1 设计原则

1. **能力先行**：任何一次 agent 运行都由显式 `CapabilityPolicy` 描述（工具集、环境白名单、是否信任项目配置），策略在**一处**计算，并且是子进程参数与环境的唯一来源。不把进程级做不到的隔离（路径与网络限制）写进策略假装已生效。
2. **结构化输出优先于解析**：模型产出通过带 schema 的工具调用回传，而不是从散文里正则提取。
3. **退出码是外部契约**：门禁失败、报告非法、基础设施故障三者必须是不同的码。
4. **纯核心 + 适配器**：核心层不 import `node:fs`/`node:child_process`/`fetch`，因此可在毫秒级单测覆盖全部分支。
5. **按真实用例演进**：通用 runner、PR 审查、Issue 分类三个用例共享 `ExitCode`、`RunResult`、`redact`、`adapters/github`；`CapabilityPolicy` 与 `adapters/pi` 仅服务前两者。

### 2.2 分层与依赖方向

```
entrypoints/          只做装配与进程语义（读输入、写输出、定退出码）
      ↓
application/          用例编排：run-agent、review-pr、triage-issue（依赖端口接口）
      ↓
core/                 纯领域：策略决策、预算规划、报告归一化、门禁判定、分类校验
      ↑（实现端口）
adapters/             git / pi 进程 / GitHub API / TypeSafe API / 文件与 artifact / 日志
```

依赖只能向下，跨层只能通过 `contracts` 中的类型。核心层拿不到 `process.env`。

### 2.3 目录结构

```
packages/
  contracts/                 # 纯类型 + TypeBox schema，零 IO（与 pi 扩展共用同一校验库）
    src/agent-spec.ts        # AgentSpec、ToolPolicy、CapabilityPolicy
    src/review.ts            # DiffInventory、ReviewReport、Finding、GateDecision
    src/triage.ts            # TriageConfig、Classification、TriageDecision
    src/result.ts            # RunResult 信封、ExitCode 枚举
  core/                      # 纯函数，可 100% 单测
    src/capability/policy.ts # CapabilityPolicy → SandboxSpec（工具集 + env 白名单）
    src/review/budget.ts     # DiffInventory + Budget → ChunkPlan（真正裁剪）
    src/review/report.ts     # 模型结构化产物 → ReviewReport（校验 + 归一化）
    src/review/gate.ts       # ReviewReport + FailOn → GateDecision
    src/review/merge.ts      # 分块报告合并、去重、覆盖率计算
    src/review/policy.ts     # Issue/PR 类型 → ReviewPlan（见 triage-design.md）
    src/triage/*             # 见 triage-design.md
  adapters/
    src/git.ts               # base 解析 / merge-base / 文件清单 / patch 落盘 / 凭据清理
    src/pi.ts                # 子进程启动、JSON 事件流读取、超时与取消
    src/github.ts            # 评论 upsert、分页、重试、限流、labels 与 linked issues
    src/typesafe.ts          # Jev HTTP 调用（见 triage-design.md）
    src/workspace.ts         # 上下文目录、artifact、step summary
    src/log.ts               # 结构化日志 + 脱敏
  actions/                   # 各入口的 application 层用例
    src/run-agent.ts
    src/review-pr.ts
    src/triage-issue.ts
  extensions/                # 从 pi-config 迁入，纳入 tsc 检查
scripts/setup-pi-cli.sh      # 安装/缓存的唯一实现，各 action.yml 只调用它
action.yml                   # root：声明输入 + 调用 dist/run-agent.js
pr-review/action.yml         # 声明输入 + 调用 dist/review-pr.js
issue-triage/action.yml      # 声明输入 + 调用 dist/triage-issue.js
```

`dist/` 由 esbuild 打包成**单文件入口**并提交（action 运行时不装依赖），CI 校验 `dist` 与源码一致。

### 2.4 关键契约

**能力策略（唯一裁决点）**

```ts
export interface CapabilityPolicy {
  tools: string[];              // 精确白名单，不做 +name/-name 混用
  envAllow: string[];           // 精确白名单，非黑名单
  trustProject: boolean;        // 对应 --approve / --no-approve；PR 审查恒为 false
  allowMcp: boolean;            // PR 审查恒为 false（传 --no-mcp）
}

export interface SandboxSpec {
  argv: string[];               // 最终 pi 参数
  env: Record<string, string>;  // 最终子进程环境（仅含固定安全集 + envAllow 命中项）
  redactedArgv: string[];
}
```

`buildSandboxSpec(policy, hostEnv)` 是纯函数，因此"给了什么工具"与"给了什么环境"不可能再分叉；S3 从根上消失。

环境变量白名单的来源（解决硬编码 25 项密钥落后问题）：

- **固定基础集**：`PATH`、`HOME`、`TMPDIR`、`RUNNER_TEMP`、`LANG`、`LC_ALL`、`TERM`、`NODE_EXTRA_CA_CERTS`、`HTTPS_proxy`、`HTTP_proxy`、`NO_PROXY`，外加固定常量 `CI=true`、`GIT_PAGER=cat`、`PAGER=cat`、`GH_PROMPT_DISABLED=1`。
- **模型凭据集**：由输入 `provider` 映射到该 provider 所需的变量名（未传 `provider` 时从 `model` 前缀推导），加上用户通过 `env_allow` 输入显式声明的变量名。**不再维护全量 provider 名单**；未匹配到的 `*_KEY`/`*_TOKEN`/`INPUT_*` 一律不进入子进程。
- **GitHub 凭据**：仅当 `tools` 含 `bash` 时才将 `github_token` 注入为 `GH_TOKEN`。

**工作区凭据与输出脱敏（补齐 S2）**

仅靠 env 白名单不够，因为 `read` 工具可读工作区文件与 `/proc/self/environ`：

1. 文档与示例 workflow 统一要求 `actions/checkout` 设置 `persist-credentials: false`。
2. `git.resolveBase` 在启动 pi **之前**执行 `git config --local --unset-all http.https://github.com/.extraheader`（忽略未设置时的退出码），把 checkout 可能留下的持久化 token 从 `.git/config` 清除；需要 fetch base 时用一次性 `GIT_CONFIG_PARAMETERS` 注入，不落盘。
3. 评论发布与 Step Summary 写入前，统一用已知敏感值集合（当前进程中的 `GITHUB_TOKEN`、`INPUT_*`、放行的 `*_KEY` 的**实际值**，长度 ≥ 8）做精确子串脱敏，防止通过评论外带。
4. 路径与网络级隔离（限制 `read` 只读特定目录、禁网）需要 OS 沙箱（如 `bwrap`），不在 `CapabilityPolicy` 中假装支持；若有需要单独作为容器化方案评估。

**结构化输出**：审查阶段通过内置扩展注册 `submit_review` 工具（TypeBox `parameters` schema），并在 `CapabilityPolicy.tools` 中显式加入 `submit_review`（`--tools` 是精确白名单，未列出的扩展工具不会暴露给模型）。运行侧用 `pi --mode json` 按 LF 切分读取 JSONL 事件流（不用 `readline`，见 pi 文档 `json.md`），等待 `agent_settled`。工具在 `execute()` 中把校验后的负载写入 `details`，读取侧从 `turn_end.toolResults` 的 `ToolResultMessage.details`（或同轮 assistant 消息的 `toolCall.arguments`）提取，并在 P2 用原型测试固定其中一种。清理层不再需要 `extractJsonReport`。

**结果信封与退出码**

```ts
export enum ExitCode {
  Ok = 0,                 // 通过、skipped（如无密钥的 fork PR）、triage 降级
  GateFailed = 10,        // 达到 fail_on 阈值
  InvalidReport = 20,     // 模型未调用 submit_review、schema 校验失败、或未审完计划内的 chunk
  Infrastructure = 30,    // git / 网络 / 进程崩溃 / 凭据或配置错误
}
```

每个入口都写 `<artifactDir>/result.json`（`RunResult`），同时映射为 `GITHUB_OUTPUT`（保留 v1 现有输出名，值升级为新退出码）；`pr-review/action.yml` 的 Enforce 步骤按**枚举**分派，而不是透传未知码。无模型凭据时（如 fork PR）直接写 `verdict: "skipped"` 并以 `ExitCode.Ok` 退出，与 v1 行为一致。

**预算、覆盖率与分块执行**

- **两个分母分开汇报**：
  - `plannedCoverage = reviewedChunks / plannedChunks`（相对于预算裁剪后的计划）。
  - `totalCoverage = reviewedChunks / totalChunks`（相对于整个 PR 的全部 diff）。
- `max_chunks` 在 `core/review/budget.ts` 中真正裁剪：`plannedChunks = min(totalChunks, maxChunks)`。因 `max_chunks` 裁剪而未审的 chunk **不触发** `InvalidReport`，但在评论头部显式标注 `totalCoverage` 与未审文件数；未达到 `totalCoverage === 1` 时，`verdict` 最高为 `comment`，不得给出 `approve`。
- 计划内的 chunk 因超时或错误未能完成（`plannedCoverage < 1`）时，返回 `InvalidReport`，除非显式设置 `allow_partial=true`。
- **每 chunk 调用的权衡**：每 chunk 一次 pi 调用，带 `concurrency`（默认 2），换取单次时长可控与失败隔离；代价是系统提示词与 `REVIEW_CONTEXT.md` 按 chunk 重复计费，且跨文件问题只能在同一 chunk 内发现。为此 `budget.ts` 按目录亲和度聚类分块，且當 `totalChunks === 1` 时退化为单次调用（与 v1 成本相同）。
- `core/review/merge.ts` 按 `(file, lineRange, category)` 合并重复 finding，保留最高 severity。
- **重试边界**：仅当 pi 子进程因超时被杀，或 JSON 事件流中记录到上游 429/5xx 错误且未产出 `submit_review` 时，对该 chunk 做带 jitter 的指数退避（最多 2 次）；schema 校验失败、进程被信号终止不重试。
- 每个 chunk 产物落盘到 `chunks/<n>.report.json`，供同一次运行内汇总与上传 artifact 排障；**跨 workflow run 的断点续跑不在 v2 范围内**（GitHub Actions 重跑会换新 runner，引入 cache 续跑带来的失效与脏状态复杂度高于收益）。

**评论发布**

- 分页拉取直到最后一页（去掉 10 页上限），对 429 / 5xx 按 `Retry-After` 或指数退避重试（上限 3 次）。
- 并发防重依靠 workflow 层的 `concurrency: group: pr-review-${{ github.event.pull_request.number }}`（README 示例已包含），不在客户端做伪原子锁。
- 只有评论发布步骤持有 `GITHUB_TOKEN`。

### 2.5 数据流（PR 审查）

```
inputs ──parse/validate──▶ ReviewRequest
        │
        ├─ git.scrubCredentials ──▶ 清除 .git/config 中可能残留的 extraheader
        ├─ git.resolveBase ──▶ baseSha（缺失则带临时凭据与超时 fetch，失败 → Infrastructure）
        ├─ git.diffInventory ─▶ DiffInventory（纯数据）
        ├─ CredsCheck ──▶ 无模型凭据则写 verdict=skipped, ExitCode.Ok 并结束
        ├─ core.review.policy ─▶ ReviewPlan（可选：结合 Issue/PR 类型，见 triage-design.md）
        ├─ core.budget.plan ──▶ ChunkPlan（按目录聚类 + 真正裁剪到 max_chunks 内）
        ├─ workspace.materialize ─▶ contextDir（patches/ + base/ + manifest.json）
        ├─ pi.run(policy, chunk) × N（受控并发、瞬时错误重试、落盘）──▶ ChunkReport[]
        ├─ core.report.merge ─▶ ReviewReport（去重 + planned/total 双覆盖率）
        ├─ core.gate.decide ──▶ GateDecision
        ├─ log.redactOutput ──▶ 对评论与 summary 做敏感值脱敏
        ├─ github.upsertComment（幂等、完整分页、退避）──▶ commentId
        └─ ResultWriter ──▶ result.json + step summary + outputs + exit code
```

---

## 3. 分阶段迁移

**前置约束**：v1 已被外部仓库以 `@main` 引用。任何破坏性变更前必须先打 `v1` tag 冻结旧契约；安全修复（P1）排在架构搭建之前，直接进 `main`。

每阶段都可独立合并、独立回滚；旧的 `scripts/` 在 P5 直接删除，不留兼容层。

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| P1 安全止血（最优先） | 在现有 v1 代码上以**最小改动**落地：`--no-approve` + `defaultProjectTrust: "never"` + `--no-mcp`；`.git/config` extraheader 清理；env 改为固定基础集 + 当前 provider key 白名单；单点 `buildSandboxSpec`；输出敏感值脱敏；打 `v1.0.0` 与移动 tag `v1` | 单测断言：子进程 env 不含 `GITHUB_TOKEN`/`GH_TOKEN`/`INPUT_*` 及非当前 provider 的 `*_KEY`；`.git/config` 含 token 时运行后被清除；评论含 token 值时被替换为 `***`；现有 selftest 全绿 |
| P0 地基 | workspace + TS + tsc 严格模式 + vitest + TypeBox；`contracts` 与 `core/capability`（迁入 P1 的 `buildSandboxSpec`）；`scripts/setup-pi-cli.sh` 收敛两份安装块 | `pnpm test` 全绿；CI 校验 `dist` 与源码一致；两个 `action.yml` 的安装逻辑只剩一行调用 |
| P2 通用 runner v2 | 原型验证 `submit_*` 工具在 `pi --mode json` 下的精确取值字段；实现 `actions/run-agent` + `adapters/pi` + `ResultWriter` + 新退出码 | 契约测试用假 pi 可执行文件覆盖：正常、超时、非零退出、超长输出、事件流含 U+2028、事件流损坏 |
| P3 审查管线 v2 | `core/review/*` + `adapters/git` + `submit_review` 扩展工具 + 分块执行 | golden fixture：给定期望 patch 集與 `max_chunks`，断言 `ChunkPlan`、`plannedCoverage`/`totalCoverage` 与最终 `ReviewReport` 完全确定；无凭据时返回 `skipped` + `ExitCode.Ok` |
| P4 发布与门禁 v2 | `adapters/github`（去除分页上限、429/5xx 退避）、`GateDecision`、双 `action.yml` 切到 `dist/` | 单测覆盖：0/1/50/100/1000+ 条评论分页；429 `Retry-After` 与 5xx 退避 |
| P5 收尾 | 删除 `scripts/`、`docs/` 更新、tag `v2.0.0`、`@v1` 迁移说明 | `git grep` 无残留 `scripts/` 引用；外部仓库按 README 示例可跑 |

Issue 分类（T1）在 P0 之后即可并行开展，联动（T2）在 P3 之后接入，详见 [triage-design.md](./triage-design.md#9-排期与验收)。

---

## 4. 可观测性

- 日志只走 stderr，单行 `key=value` 或 JSON，统一经 `redact()`（基于键名模式 `*_KEY`/`*_TOKEN`/`Authorization`/`--api-key` 以及当前已知敏感值集合的双重脱敏）。
- 每次运行产出 `result.json`：`{ schemaVersion, status, exitCode, verdict, coverage: { planned, total }, findings, timings: { resolveBase, diff, agent[], publish }, agentUsage }`。
- Step Summary 只放人需要看的结论；机器消费一律用 outputs / artifact。
