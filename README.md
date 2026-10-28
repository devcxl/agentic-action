# Pi Coding Agent Action

基于 Pi Coding Agent 的 GitHub Composite Action 套件。提供**双入口架构**：
- `devcxl/agentic-action`：纯粹、安全的**通用 AI Agent 执行器**（参数化调用、输出契约、权限隔离、二进制安装目录级缓存）。
- `devcxl/agentic-action/pr-review`：**超大型 PR 本地比对审查子 Action**（开箱即用，外部仓库无需复制任何脚本或提示词文件）。

---

## 核心特性

- **双入口单一职责**：根 Action 专注通用任务执行，子 Action `./pr-review` 专注大型 PR 审查，接口干净不耦合。
- **开箱即用超大型 PR 审查**：在 Runner 内基于全量 git `merge-base` 生成分块 diff 与 base 快照，绕开 GitHub diff API 的 20000 行上限（`HTTP 406 too_large`）。
- **最小权限与安全隔离**：
  - 审查上下文生成在 `${RUNNER_TEMP}/pi-review-context`，不污染工作区，不干扰 Agent 的 `grep`/`find`。
  - 当未启用 `bash` 工具时，自动从 `pi` 子进程环境变量中剥离 `GH_TOKEN`/`GITHUB_TOKEN`；PR 审查默认仅开启纯只读工具（`read,grep,find,ls`），从根源上杜绝提示词注入篡改文件或窃取 Token。
  - CLI 参数通过 Node.js `spawn` 数组传递并自动使用 `--` 隔离位置参数，自动对 `--api-key` 日志脱敏。
- **Marker 级精准幂等回评**：通过 GitHub API 精确查找包含 `<!-- pi-review:begin -->` 的评论并原地更新，不会像 `gh pr comment --edit-last` 那样误覆盖同仓库其他 Bot 的评论。
- **版本锁定与极速缓存**：支持 `pi_version`（默认锁定稳定版），直接缓存 `~/.pi-cli` 安装目录，命中缓存时免去 `npm install -g` 开销。

---

## 快速开始

### 场景 1：超大型 PR 代码审查与幂等回评（推荐，零脚本复制）

在 `.github/workflows/pr-review.yml` 中直接引用 `devcxl/agentic-action/pr-review@main`：

```yaml
name: PR Review

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

concurrency:
  group: pr-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    if: github.event.pull_request.draft == false
    runs-on: ubuntu-latest
    steps:
      - name: Checkout PR head (full history)
        uses: actions/checkout@v4
        with:
          ref: refs/pull/${{ github.event.pull_request.number }}/head
          fetch-depth: 0

      - name: Run Pi PR Review
        uses: devcxl/agentic-action/pr-review@main
        with:
          provider: 'half-cabbage'
          model: 'minimax-m3'
          thinking: 'high'
          fail_on: 'high'
          exclude: '**/dist/**,**/vendor/**'
          github_token: ${{ secrets.GITHUB_TOKEN }}
        env:
          HALF_CABBAGE_BASE_URL: ${{ secrets.HALF_CABBAGE_BASE_URL }}
          HALF_CABBAGE_API_KEY: ${{ secrets.HALF_CABBAGE_API_KEY }}
```

更多细节参见 [超大型 PR 审查文档](docs/large-pr-review.md)。

### 场景 2：通用代码库分析与结构化 Output 消费

使用根入口 `devcxl/agentic-action@main` 执行任意 Agent 任务，并通过 `steps.<id>.outputs.result` 或 `result_file` 消费输出：

```yaml
name: Codebase Health Analysis

on:
  workflow_dispatch:

jobs:
  analyze:
    runs-on: ubuntu-latest
    permissions:
      contents: read

    steps:
      - uses: actions/checkout@v4

      - name: Run Analysis
        id: analysis
        uses: devcxl/agentic-action@main
        with:
          model: 'openai/gpt-4o'
          tools: 'read,grep,find,ls'
          prompt: '分析 src/ 目录下的模块划分和循环依赖情况，生成 Markdown 格式的架构评估报告。'
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}

      - name: Use Output
        run: |
          echo "Result saved at: ${{ steps.analysis.outputs.result_file }}"
```

### 场景 3：从文件加载系统提示词与多文件上下文

`prompt`、`system_prompt`、`append_system_prompt` 均支持传入内联文本或仓库内文件路径；`context_files` 支持空格、逗号或换行分隔：

```yaml
- name: Review with External Prompt Files
  uses: devcxl/agentic-action@main
  with:
    model: 'claude-3-7-sonnet'
    system_prompt: '.github/prompts/security_rules.md'
    prompt: '.github/prompts/review_task.md'
    context_files: |
      docs/architecture.md
      docs/conventions.md
```

### 场景 4：Issue 分类（纯推理模式，完全禁用工具）

```yaml
- name: Classify Issue
  id: classify
  uses: devcxl/agentic-action@main
  with:
    model: 'google/gemini-2.5-pro'
    no_tools: 'true'
    prompt: |
      对以下 Issue 分类，只返回 bug、feature 或 question。
      标题：${{ github.event.issue.title }}
      内容：${{ github.event.issue.body }}
  env:
    GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
```

---

## 根 Action：`devcxl/agentic-action`

### 输入参数（Inputs）

| 参数名称 | 类型 | 必填 | 默认值 | 描述 |
| :--- | :--- | :--- | :--- | :--- |
| `model` | String | **是** | - | 模型标识符（如 `gpt-4o`, `claude-3-7-sonnet`, 或 `provider/model`） |
| `prompt` | String | **是** | - | 执行的主要提示词或指令（支持内联文本或本地文件路径） |
| `provider` | String | 否 | `""` | 模型 Provider 名称（如 `google`, `openai`, `anthropic`, `half-cabbage`） |
| `thinking` | String | 否 | `""` | 思考级别：`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `api_key` | String | 否 | `""` | 模型 API Key（优先推荐使用对应 Provider 的环境变量） |
| `tools` | String | 否 | `""` | 工具白名单；仅当包含 `bash` 时才会向子进程保留 `GH_TOKEN` |
| `exclude_tools` | String | 否 | `""` | 排除的工具黑名单（逗号分隔） |
| `no_builtin_tools` | Boolean | 否 | `'false'` | 是否禁用所有内置工具，仅保留扩展工具 |
| `no_tools` | Boolean | 否 | `'false'` | 是否彻底禁用所有工具（纯文本推理模式） |
| `system_prompt` | String | 否 | `""` | 覆盖系统提示词（支持内联文本或本地文件路径） |
| `append_system_prompt` | String | 否 | `""` | 追加系统提示词（支持内联文本或本地文件路径） |
| `context_files` | String | 否 | `""` | 空格、逗号或换行分隔的上下文文件路径列表（作为 `@file` 注入） |
| `prompt_template` | String | 否 | `""` | 指定提示词模板文件或目录路径 |
| `github_token` | String | 否 | `${{ github.token }}` | 当开启 `bash` 工具时暴露为 `GH_TOKEN` 的 GitHub Token |
| `pi_version` | String | 否 | `'1.4.0'` | 安装的 `@earendil-works/pi-coding-agent` 版本（可设为 `latest`） |
| `mode` | String | 否 | `'text'` | 输出模式：`text` 或 `json` |
| `result_file` | String | 否 | `""` | 自定义保存原始输出的文件路径 |
| `write_summary` | Boolean | 否 | `'true'` | 是否将输出追加到 `GITHUB_STEP_SUMMARY` |

### 输出参数（Outputs）

| 输出名称 | 描述 |
| :--- | :--- |
| `result` | Agent 标准输出内容（超长时截断至 32KB） |
| `result_file` | 保存完整原始输出的本地文件路径 |
| `exit_code` | Pi 进程退出码 |

---

## 子 Action：`devcxl/agentic-action/pr-review`

### 输入参数（Inputs）

| 参数名称 | 类型 | 必填 | 默认值 | 描述 |
| :--- | :--- | :--- | :--- | :--- |
| `model` | String | **是** | - | 模型标识符 |
| `provider` | String | 否 | `""` | 模型 Provider 名称 |
| `thinking` | String | 否 | `'high'` | 思考级别 |
| `api_key` | String | 否 | `""` | 模型 API Key |
| `pr_number` | String | 否 | `${{ github.event.pull_request.number }}` | 要审查的 PR 编号 |
| `base_sha` | String | 否 | `${{ github.event.pull_request.base.sha }}` | 比对基准 SHA（未传时自动通过 `gh pr view` 查询并按需 fetch） |
| `max_chunks` | String | 否 | `'0'` | 本次最多审查的 chunk 数（`0` = 不限） |
| `exclude` | String | 否 | `""` | 额外排除的 glob 列表（逗号分隔，叠加在默认排除规则之上） |
| `fail_on` | String | 否 | `'high'` | 门禁级别：`none`, `low`, `medium`, `high`, `critical` |
| `post_comment` | Boolean | 否 | `'true'` | 是否自动按 HTML marker 幂等发布/更新 PR 评论 |
| `comment_marker` | String | 否 | `'pi-review'` | 幂等更新所使用的 HTML Marker 名称 |
| `upload_artifact` | Boolean | 否 | `'true'` | 是否自动上传审查上下文与报告到 Workflow Artifact |
| `prompt` | String | 否 | `""` | 附加在内置审查指令之后的自定义审查要求 |
| `append_system_prompt` | String | 否 | `""` | 附加在内置审查契约之后的补充系统提示词 |
| `tools` | String | 否 | `'read,grep,find,ls'` | 审查工具集（默认严格只读） |
| `github_token` | String | 否 | `${{ github.token }}` | 用于拉取 base 与发布评论的 Token（不会暴露给只读 Pi 子进程） |

### 输出参数（Outputs）

| 输出名称 | 描述 |
| :--- | :--- |
| `result` | 渲染后的 PR 审查评论 Markdown |
| `comment_file` | 渲染后的 `review-comment.md` 路径 |
| `report_file` | 归一化后的 `report.json` 路径 |
| `context_dir` | 生成的审查上下文目录路径 |
| `verdict` | 审查结论（`approve` / `comment` / `request_changes` / `skipped` / `error`） |
| `findings_count` | 发现的问题数量 |
| `exit_code` | 门禁退出码（`0` 通过，`1` 命中 `fail_on`，`2` 报告异常） |

---

## 环境变量参考

根据调用的 Provider 与扩展，在 workflow 的 `env:` 中配置对应的密钥：

- **Half Cabbage Provider**:
  - `HALF_CABBAGE_BASE_URL`: API 基础地址
  - `HALF_CABBAGE_API_KEY`: API 密钥（同时向前兼容 `HALF_CABBAGE_KEY`）
- **官方 Providers**:
  - `OPENAI_API_KEY`: OpenAI 密钥
  - `ANTHROPIC_API_KEY`: Anthropic 密钥
  - `GEMINI_API_KEY`: Google Gemini 密钥
- **Web 搜索扩展**:
  - `EXA_API_KEY`: Exa Search API 密钥
