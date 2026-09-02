# Pi Coding Agent Action

基于 Pi Coding Agent 的 GitHub Composite Action，支持参数化调用、多模型与自定义 Provider、工具权限精细控制，以及自动 PR 差异审查与回评。

---

## 核心特性

- **参数化配置**：全面覆盖 Pi CLI 的常用参数，包括 Provider、模型、思考级别（Thinking）、工具白/黑名单、提示词模板等。
- **内置扩展支持**：自带 `half-cabbage` 自定义 Provider 与基于 Exa Search API 的 `web_search` 扩展。
- **交互式 HTML 导出与在线预览**：自动调用 `pi --export` 导出富交互式 HTML 会话报告，可无缝对接 GitHub Pages 实现免下载点击即看。
- **PR 审查自动化**：自动提取 PR 的 Git Diff 上下文，结合上下文执行代码审查并判断通过状态（`PASS` / `BLOCKED`）。
- **CI 安全与整洁**：强制使用非交互模式（`-p`），支持设置只读工具白名单。
- **多途径结果导出**：支持 GitHub Action Step Summary 可视化、Step Outputs 变量、PR 自动回评与在线网页链接。

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
          prompt: '请对 PR 的改动进行代码审查，分析潜在的并发缺陷、安全漏洞与逻辑错误。'
          thinking: 'high'
          tools: 'read,grep,find,ls,web_search' # 限制为只读与搜索工具
          post_comment: 'true'
          github_token: ${{ secrets.GITHUB_TOKEN }}
        env:
          HALF_CABBAGE_BASE_URL: ${{ secrets.HALF_CABBAGE_BASE_URL }}
          HALF_CABBAGE_API_KEY: ${{ secrets.HALF_CABBAGE_API_KEY }}
          EXA_API_KEY: ${{ secrets.EXA_API_KEY }}

      - name: Check Verdict Gate
        if: steps.pi_review.outputs.verdict == 'BLOCKED'
        run: |
          echo "PR review gate failed: Issues identified by reviewer."
          exit 1
```

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

### 场景 3：结合 GitHub Pages 提供直接点击在线预览

通过将导出的 HTML 报告部署至 `gh-pages` 分支，PR 评论中将直接附带可点击的网页链接：

```yaml
name: PR Review with Live HTML Preview

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: write # 部署到 gh-pages 分支所需权限
      pull-requests: write # 发表 PR 评论所需权限

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
          prompt: '请对 PR 的改动进行代码审查，输出规范的 Markdown 报告并给出 PASS 或 BLOCKED 结论。'
          thinking: 'high'
          tools: 'read,grep,find,ls,web_search'
          post_comment: 'true'
          export_html: 'true'
          github_token: ${{ secrets.GITHUB_TOKEN }}
        env:
          HALF_CABBAGE_BASE_URL: ${{ secrets.HALF_CABBAGE_BASE_URL }}
          HALF_CABBAGE_API_KEY: ${{ secrets.HALF_CABBAGE_API_KEY }}
          EXA_API_KEY: ${{ secrets.EXA_API_KEY }}

      # 将 HTML 报告发布到 gh-pages 分支对应 run 目录
      - name: Deploy Report to GitHub Pages
        if: steps.pi_review.outputs.html_report_path != ''
        uses: peaceiris/actions-gh-pages@v4
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          publish_dir: /tmp
          destination_dir: reports/run-${{ github.run_id }}
          keep_files: true
```

### 场景 4：从文件加载系统提示词与任务指令

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

### 场景 5：纯文本推理（完全禁用工具）

```yaml
- name: Summarize Changelog
  uses: devcxl/agentic-action@main
  with:
    model: 'google/gemini-2.5-pro'
    no_tools: 'true'
    context_files: 'CHANGELOG.md'
    prompt: '根据上述 CHANGELOG.md 生成一段 200 字以内的版本发布要点摘要。'
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
| `tools` | String | 否 | `""` | 允许调用的工具白名单（逗号分隔，如 `read,grep,find,ls`） |
| `exclude_tools` | String | 否 | `""` | 排除的工具黑名单（逗号分隔） |
| `no_builtin_tools` | Boolean | 否 | `'false'` | 是否禁用所有内置工具，仅保留扩展工具 |
| `no_tools` | Boolean | 否 | `'false'` | 是否彻底禁用所有工具（纯文本推理模式） |
| `system_prompt` | String | 否 | `""` | 覆盖系统提示词（支持内联文本或本地文件路径） |
| `append_system_prompt` | String | 否 | `""` | 追加系统提示词（支持内联文本或本地文件路径） |
| `context_files` | String | 否 | `""` | 空格分隔的上下文文件路径列表（作为 `@file` 注入） |
| `prompt_template` | String | 否 | `""` | 指定提示词模板文件或目录路径 |
| `post_comment` | Boolean | 否 | `'false'` | 是否在 PR 事件中自动将结果发表为 PR Comment |
| `export_html` | Boolean | 否 | `'true'` | 是否导出交互式 HTML 报告 |
| `pages_base_url` | String | 否 | `""` | GitHub Pages 基础域名（默认自动推导为 `https://<owner>.github.io/<repo>`） |
| `github_token` | String | 否 | `${{ github.token }}` | 用于读取 PR 信息和发表评论的 GitHub Token |
| `mode` | String | 否 | `'text'` | 输出模式：`text` 或 `json` |

---

## 输出参数（Outputs）

| 输出名称 | 类型 | 描述 |
| :--- | :--- | :--- |
| `verdict` | String | 审查判定结果：`PASS`、`BLOCKED` 或 `UNKNOWN` |
| `report_path` | String | 生成的审查报告 Markdown 文件路径（通常位于 `/tmp/pi_report.md`） |
| `html_report_path` | String | 导出的交互式 HTML 报告物理文件路径（位于 `/tmp/pi_report.html`） |
| `html_report_url` | String | 预测的 GitHub Pages 在线预览 URL 链接 |
| `result` | String | Pi 代理运行产生的完整输出文本 |

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
