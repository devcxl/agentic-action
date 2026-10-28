# 超大型 PR 审查（本地比对方案）

面向超大型 PR（改动数千至数万行）的代码审查方案。核心思路：**在 Runner 内用 checkout 下来的全量代码做 git 比对，绕开 GitHub diff API 的 20000 行上限**，并通过子 Action `devcxl/agentic-action/pr-review` 提供开箱即用的一站式体验。

## 为什么不用 `gh pr diff`

GitHub 的 diff media type 有硬上限，超过即返回：

```
HTTP 406 Not Acceptable
{"message":"Sorry, the diff exceeded the maximum number of lines (20000)","errors":[{"resource":"PullRequest","field":"diff","code":"too_large"}]}
```

这不是限流，重试也没用；用本地 `git diff <merge-base> <head>` 没有这个限制。

## 架构组成

| 文件 | 作用 |
| --- | --- |
| `pr-review/action.yml` | 子 Action 入口：封装环境安装、上下文构建、只读审查、Marker 回评、Artifact 上传与门禁 |
| `scripts/pr-review/run-review.mjs` | PR 审查全链路 Node 编排器 |
| `scripts/pr-review/build-context.mjs` | 计算 merge-base、生成逐文件 patch、分块、导出 base 快照与 manifest |
| `scripts/pr-review/render-comment.mjs` | 从 Agent 输出中提取并归一化 JSON 报告、渲染评论 Markdown、判定 `--fail-on` 门禁 |
| `scripts/pr-review/publish-comment.mjs` | 基于 `<!-- pi-review:begin -->` HTML Marker 的精准幂等评论发布器 |
| `.github/prompts/pr-review.md` | 内置审查系统提示词与 JSON 输出契约 |

## 关键设计点

1. **比对基准必须是 merge-base（三点）**：脚本一律使用 `git merge-base <base> <head>` 的结果作为 diff 左端，避免在 PR 落后于主分支时把主分支的新提交当成 PR 的反向修改。
2. **必须 `fetch-depth: 0`**：浅克隆无法计算 merge-base；脚本会检测并直接报错，避免静默产出错误结论。
3. **上下文生成在工作区外（`${RUNNER_TEMP}/pi-review-context`）**：避免 `base/` 快照和 `patches/` 污染工作区，也避免 Agent 在工作区执行 `grep` / `find` 时误扫入旧版本快照文件。
4. **纯只读工具与 Token 物理隔离**：
   - 改动前版本已预导出到 `<CONTEXT_DIR>/base/`，Agent 仅需只读工具（`read,grep,find,ls`）即可完成前后对照。
   - Agent 直接在回复中输出 JSON 报告并由外层进程提取，无需开启 `write` 工具，也无需开启 `bash` 工具。
   - 外层进程在启动只读 `pi` 子进程时自动从环境变量中剔除 `GH_TOKEN` / `GITHUB_TOKEN`，彻底杜绝恶意 PR 通过 Prompt Injection 篡改工作区或窃取 Token。
5. **基于 HTML Marker 的真幂等回评**：`publish-comment.mjs` 通过 GitHub API 查找包含 `<!-- pi-review:begin -->` 的评论并 `PATCH` 更新，绝不会误覆盖同仓库其他 GitHub Actions Bot 发布的评论。
6. **门禁在回评之后**：先发布审查评论并上传 Artifact，最后才根据 `fail_on` 退出码决定步骤成败。

## 在外部仓库中使用

无需复制任何脚本或提示词文件，直接在目标仓库的 `.github/workflows/pr-review.yml` 中引用 `devcxl/agentic-action/pr-review@main`：

```yaml
steps:
  - uses: actions/checkout@v4
    with:
      ref: refs/pull/${{ github.event.pull_request.number }}/head
      fetch-depth: 0

  - uses: devcxl/agentic-action/pr-review@main
    with:
      provider: 'half-cabbage'
      model: 'minimax-m3'
      fail_on: 'high'
      exclude: '**/dist/**,**/vendor/**'
    env:
      HALF_CABBAGE_BASE_URL: ${{ secrets.HALF_CABBAGE_BASE_URL }}
      HALF_CABBAGE_API_KEY: ${{ secrets.HALF_CABBAGE_API_KEY }}
```

## 独立运行上下文构建脚本（本地调试）

```bash
node scripts/pr-review/build-context.mjs \
  --base "$(git rev-parse origin/main)" \
  --out /tmp/review-context \
  --base-snapshot \
  --exclude '**/package-lock.json,**/dist/**'
```
