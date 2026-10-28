# 超大型 PR 审查（本地比对方案 v2）

面向超大型 PR（改动数千至数万行）的代码审查方案。核心思路：**在 Runner 内用 checkout 下来的全量代码做 git 比对，绕开 GitHub diff API 的 20000 行上限**，并通过子 Action `devcxl/agentic-action/pr-review` 提供开箱即用的一站式体验。

架构演进与契约细节参见 [architecture-v2.md](./architecture-v2.md)，Issue 分类与 PR 联动设计参见 [triage-design.md](./triage-design.md)。

## 为什么不用 `gh pr diff`

GitHub 的 diff media type 有硬上限，超过即返回：

```
HTTP 406 Not Acceptable
{"message":"Sorry, the diff exceeded the maximum number of lines (20000)","errors":[{"resource":"PullRequest","field":"diff","code":"too_large"}]}
```

这不是限流，重试也没用；用本地 `git diff <merge-base> <head>` 没有这个限制。

## 架构组成（v2）

| 模块 | 作用 |
| --- | --- |
| `pr-review/action.yml` | 子 Action 入口：调用 `scripts/setup-pi-cli.sh`、`dist/setup-pi-config.js` 与 `dist/review-pr.js`，并按 `ExitCode` 枚举执行门禁 |
| `packages/contracts/` | 纯类型与常量契约（`CapabilityPolicy`、`ReviewReport`、`SubmitReviewInput`、`ExitCode`，零运行时依赖） |
| `packages/core/src/review/` | 纯函数核心：按目录聚类与 `max_chunks` 预算裁剪（`budget.ts`）、分块报告合并与去重（`merge.ts`）、双覆盖率门禁判定（`gate.ts`）、Issue/PR 联动策略（`policy.ts`） |
| `packages/adapters/src/git.ts` | `.git/config` 凭据擦除、base 解析与临时凭据补拉、浅克隆校验、逐文件 patch 与 `base/` 快照生成 |
| `packages/adapters/src/pi.ts` | 启动受控 `pi --mode json` 子进程、严格按 LF 解析 JSONL 事件流、提取 `submit_review` 工具结果、瞬时错误退避重试 |
| `packages/adapters/src/github.ts` | 无页数上限的完整评论分页、基于 `<!-- pi-review:begin -->` 的幂等评论更新、429/5xx 退避重试 |
| `packages/extensions/src/submit-review.ts` | 注册 `submit_review` 结构化输出工具，模型调用后直接回传 schema 校验通过的数据并终止当前轮次 |

## 关键设计点

1. **比对基准必须是 merge-base（三点）**：一律使用 `git merge-base <base> <head>` 的结果作为 diff 左端，避免在 PR 落后于主分支时把主分支的新提交当成 PR 的反向修改。
2. **必须 `fetch-depth: 0` 且 `persist-credentials: false`**：浅克隆无法计算 merge-base（会立即报错）；同时启动 Pi 前会自动执行 `git config --local --unset-all http.https://github.com/.extraheader` 清除任何持久化凭据。
3. **上下文生成在工作区外（`${RUNNER_TEMP}/pi-review-context`）**：避免 `base/` 快照和 `patches/` 污染工作区，也避免 Agent 在工作区执行 `grep` / `find` 时误扫入旧版本快照文件。
4. **能力先行与单点沙箱策略（`CapabilityPolicy`）**：
   - PR 审查恒定开启 `--no-approve`、`--no-mcp` 与 `defaultProjectTrust: "never"`，忽略被审 PR 工作区内的 `.pi/` 配置与扩展。
   - 默认工具集仅含 `read,grep,find,ls,submit_review`。
   - 子进程环境采用严格白名单：仅放行基础系统变量与当前模型 Provider 密钥，`GITHUB_TOKEN`、`GH_TOKEN`、`TYPESAFE_API_KEY`、`INPUT_*` 一律不进入子进程。
   - 评论与 Summary 发布前经过已知敏感值精确子串脱敏。
5. **结构化工具契约（`submit_review`）与双覆盖率**：
   - 审查结果通过 `submit_review` 工具回传，不再依赖从散文中正则抠取 JSON。
   - 区分 `plannedCoverage`（相对 `max_chunks` 裁剪后的计划）与 `totalCoverage`（相对整個 PR 全部 diff）。未达到 `totalCoverage === 1` 时，`verdict` 最高为 `comment`，不会给出 `approve`。
6. **门禁退出码契约**：
   - `0` (`Ok`)：通过门禁，或无密钥时优雅跳过（`verdict=skipped`）
   - `10` (`GateFailed`)：发现达到或超过 `fail_on` 阈值的问题
   - `20` (`InvalidReport`)：模型未按契约调用 `submit_review` 或未完成计划内的分块（且未开启 `allow_partial`）
   - `30` (`Infrastructure`)：git / 网络 / 配置等基础设施错误
