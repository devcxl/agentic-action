# 超大型 PR 审查（本地比对方案）

面向超大型 PR（改动数千至数万行）的代码审查方案。核心思路：**在 Runner 内用 checkout 下来的全量代码做 git 比对，绕开 GitHub diff API 的 20000 行上限**。

## 为什么不用 `gh pr diff`

GitHub 的 diff media type 有硬上限，超过即返回：

```
HTTP 406 Not Acceptable
{"message":"Sorry, the diff exceeded the maximum number of lines (20000)","errors":[{"resource":"PullRequest","field":"diff","code":"too_large"}]}
```

这不是限流，会重试也没用；很多审查工具在大 PR 上会因此静默失败或直接中断。用本地 `git diff <merge-base> <head>` 没有这个限制。

## 组成

| 文件 | 作用 |
| --- | --- |
| `scripts/pr-review/build-context.mjs` | 计算 merge-base、生成逐文件 patch、分块、导出 base 快照与 manifest |
| `scripts/pr-review/render-comment.mjs` | 把 Agent 的结构化 JSON 渲染成 PR 评论 Markdown，并实现 `--fail-on` 门禁 |
| `.github/prompts/pr-review.md` | 审查提示词与输出契约（含安全边界与分块读取方法） |
| `.github/workflows/pr-review.yml` | 完整审查工作流：全量 checkout → 生成上下文 → Pi 审查 → 回评 → 门禁 → artifact |
| `.github/workflows/pr-review-selftest.yml` | 脚本自检（无需 secrets，不调用模型） |

## 关键设计点

**比对基准必须是 merge-base（三点）**。用 `git diff base head` 会在 PR 落后于主分支时把主分支的新提交显示成 PR 的"反向修改"。脚本一律使用 `git merge-base <base> <head>` 的结果作为 diff 左端。

**必须 `fetch-depth: 0`**。浅克隆无法计算 merge-base；脚本会检测并直接报错，避免静默产出错误结论。

**模型上下文预算靠确定性分块解决**。20k 行限制只约束 GitHub API，不约束模型上下文：十万行 diff 依然塞不进任何窗口。脚本先出 `--numstat` 清单（免费），排除 lockfile/生成物/二进制，按路径顺序切成 chunk（默认 1500 行 / 40KB），并要求 Agent 按 chunk 顺序推进。

**改动前版本预导出到 `review-context/base/`**，配合只读工具集就能完成前后对照，因此审查阶段不需要 `bash`，也就不会把 `GH_TOKEN` 暴露给一个正在阅读不可信 PR 内容的 Agent。

**输出契约化**。Agent 只写 `report.json`（severity/category/file/line/title/detail/suggestion），渲染与发布交给脚本，保证可测试、可幂等、可门禁。`coverage` 强制如实填写：只审了 2/14 个 chunk 就必须写明，避免"绿勾但零发现"的假通过。

**回评幂等**。评论用固定 HTML marker 包裹，配合 `gh pr comment --edit-last --create-if-none`，`synchronize` 时更新上一条而不是刷屏；workflow 侧用 `concurrency` 取消同 PR 的旧运行。

**门禁在回评之后**。先留下审查结论再决定退出码，`--fail-on high` 命中时 job 失败但评论已发布。

## 使用方式

复制 `scripts/pr-review/` 与 `.github/prompts/pr-review.md` 到目标仓库，并把 workflow 中的 `uses: ./` 换成 `uses: devcxl/agentic-action@<ref>`，然后在仓库配置 `HALF_CABBAGE_BASE_URL` / `HALF_CABBAGE_API_KEY`（可选 `EXA_API_KEY`）。

只跑上下文生成（不调用模型）：

```bash
node scripts/pr-review/build-context.mjs \
  --base "$(git rev-parse origin/main)" \
  --out .review-context \
  --base-snapshot \
  --exclude '**/package-lock.json,**/dist/**'
```

`manifest.json` 是审查的事实来源：`files[]`（含 rename 的 `oldPath` 与 patch 路径）、`chunks[]`、`skipped`（排除原因）、`totals`。完整参数见 `node scripts/pr-review/build-context.mjs --help`。

## 已知限制

- **fork PR 不会审查**：`pull_request` 事件下 token 只读且无 secrets，工作流只生成上下文并跳过模型与回评。若必须审查 fork PR 并回评，需改用 `pull_request_target` + `workflow_run` 两段式，保持审查段无 secrets、只读，切勿把 fork 代码交给有写权限的 job。
- **超大改动仍未覆盖完**：分块解决的是"能不能读"，不是"AI 会不会读完"。预算不足时靠 `coverage` 如实暴露，配合 `workflow_dispatch` 的 `max_chunks` 分批推进。
- **inline comment 未实现**：本方案只发单条 summary 评论。行级评论需要把 head 行号映射到 PR diff 的 `line+side`，在排除文件与超大 diff 场景下容易 422，留待后续。
- **`write` 工具仍有仓库写权限**：Agent 只被要求写 `report.json`，但工具层面无法限制路径；如需更严，可改为从 stdout 解析 JSON。

<!-- ci verification demo: triggers review context build -->
