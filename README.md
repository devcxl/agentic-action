# Pi Coding Agent Action

基于 Pi Coding Agent 的 GitHub Composite Action，支持参数化调用、多模型与自定义 Provider、工具权限精细控制，以及自动 PR 差异审查与回评。

---

## 核心特性

- **参数化配置**：全面覆盖 Pi CLI 的常用参数，包括 Provider、模型、思考级别（Thinking）、工具白/黑名单、提示词模板等。
- **通用 Agent 执行器**：Pi 的 stdout 就是任务结果，不强制绑定 PR 或报告生成，适配 Issue 处理、代码审查与通用分析任务。
- **CI 缓存提速**：内置 npm 下载缓存，避免重复下载 Pi CLI 及其依赖，显著减少 CI 启动耗时。
- **AI 自主行动**：提示词决定任务与工具调用；允许 `bash` 时，AI 可按需调用 GitHub CLI 或外部命令。

---

## 快速开始

### 场景 1：PR 智能代码审查与自动评论

在 `.github/workflows/pr-review.yml` 中添加：

```yaml
name: PR Review Gate

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write # 用于自动发布 PR 评论

    steps:
      - name: Checkout Code
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Run Pi Code Review
        id: pi_review
        uses: devcxl/agentic-action@main
        with:
          provider: 'half-cabbage'
          model: 'claude-3-7-sonnet'
          prompt: |
            请审查 PR #${{ github.event.pull_request.number }} 的代码改动。
            完成后自行决定评论内容，并使用 gh pr comment ${{ github.event.pull_request.number }} 发布到该 PR。
          thinking: 'high'
          tools: 'read,bash,grep,find,ls,web_search' # bash 允许 AI 直接调用 gh
          github_token: ${{ secrets.GITHUB_TOKEN }}
        env:
          HALF_CABBAGE_BASE_URL: ${{ secrets.HALF_CABBAGE_BASE_URL }}
          HALF_CABBAGE_API_KEY: ${{ secrets.HALF_CABBAGE_API_KEY }}
          EXA_API_KEY: ${{ secrets.EXA_API_KEY }}
```

> `bash` 会让 Agent 继承当前进程权限，包括 `GH_TOKEN`。只在需要 AI 直接操作 GitHub 时启用，并使用最小化的 Workflow permissions。

### 场景 2：通用代码库分析与任务执行

在工作流中执行特定代码检查或生成报告：

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
      - name: Checkout Code
        uses: actions/checkout@v4

      - name: Run Analysis
        uses: devcxl/agentic-action@main
        with:
          model: 'openai/gpt-4o'
          tools: 'read,grep,find,ls'
          prompt: '分析 src/ 目录下的模块划分和循环依赖情况，生成 Markdown 格式的架构健康度评估报告。'
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

### 场景 3：从文件加载系统提示词与任务指令

将复杂的 Prompt 或审查规则维护在仓库文件中（如 `.github/prompts/` 目录），Action 会自动检测并读取文件内容：

```yaml
- name: Review with External Prompt Files
  uses: devcxl/agentic-action@main
  with:
    model: 'claude-3-7-sonnet'
    system_prompt: '.github/prompts/security_rules.md' # 直接指定文件路径
    prompt: '.github/prompts/review_task.md'          # 直接指定文件路径
    context_files: 'docs/architecture.md'             # 上下文背景文件
```

### 场景 4：Issue 分类（完全禁用工具）

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

## 输入参数（Inputs）

| 参数名称 | 类型 | 必填 | 默认值 | 描述 |
| :--- | :--- | :--- | :--- | :--- |
| `model` | String | **是** | - | 模型标识符（如 `gpt-4o`, `claude-3-7-sonnet`, 或 `provider/model`） |
| `prompt` | String | **是** | - | 执行的主要提示词或指令（支持内联文本或本地文件路径） |
| `provider` | String | 否 | `""` | 模型 Provider 名称（如 `google`, `openai`, `anthropic`, `half-cabbage`） |
| `thinking` | String | 否 | `""` | 思考级别：`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `api_key` | String | 否 | `""` | 模型 API Key（优先推荐使用对应 Provider 的环境变量） |
| `tools` | String | 否 | `""` | 工具白名单；AI 需要直接调用 GitHub CLI 时加入 `bash` |
| `exclude_tools` | String | 否 | `""` | 排除的工具黑名单（逗号分隔） |
| `no_builtin_tools` | Boolean | 否 | `'false'` | 是否禁用所有内置工具，仅保留扩展工具 |
| `no_tools` | Boolean | 否 | `'false'` | 是否彻底禁用所有工具（纯文本推理模式） |
| `system_prompt` | String | 否 | `""` | 覆盖系统提示词（支持内联文本或本地文件路径） |
| `append_system_prompt` | String | 否 | `""` | 追加系统提示词（支持内联文本或本地文件路径） |
| `context_files` | String | 否 | `""` | 空格分隔的上下文文件路径列表（作为 `@file` 注入） |
| `prompt_template` | String | 否 | `""` | 指定提示词模板文件或目录路径 |
| `github_token` | String | 否 | `${{ github.token }}` | 暴露为 `GH_TOKEN` 的 GitHub Token |
| `mode` | String | 否 | `'text'` | 输出模式：`text` 或 `json` |

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
