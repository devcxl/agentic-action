# Pi Coding Agent Action (v2)

基于 Pi Coding Agent 与 TypeSafe Jev 的 GitHub Composite Action 套件。提供**四入口架构**：
- `devcxl/agentic-action`：安全、可验证的**通用 AI Agent 执行器**（显式 `CapabilityPolicy`、环境变量白名单、输出脱敏、二进制缓存）。
- `devcxl/agentic-action/pr-review`：**超大型 PR 本地比对审查子 Action**（`submit_review` 结构化工具契约、按分块并发审查、双覆盖率统计、Jev Issue/PR 联动、Marker 级幂等回评）。
- `devcxl/agentic-action/security-audit`：**第三方代码安全审计子 Action**（支持直接对第三方仓库全量快照 `codebase` 或 PR 变更 `diff` 进行只读安全审计，覆盖供应链投毒/后门检测、信任边界漏洞验证与严重级别门禁）。
- `devcxl/agentic-action/triage`：**基于 TypeSafe Jev（System One 判别式模型）的 Issue 自动分类子 Action**（白名单与校准置信度门限校验、低置信度安全降级、幂等打标）。

> **版本与迁移说明**：
> - `@v1`（及 `@v1.0.0`）已冻结旧版契约。
> - `@v2` / `@v2.0.0` / `@main` 采用 v2 架构（见 [architecture-v2.md](docs/architecture-v2.md) 与 [triage-design.md](docs/triage-design.md)）：默认开启 `--no-approve` 与 `--no-mcp`（不信任被审工作区 `.pi` 配置），退出码升级为正交枚举（`0` Ok、`10` GateFailed、`20` InvalidReport、`30` Infrastructure）。

---

## 核心特性

- **能力先行与默认安全（`CapabilityPolicy`）**：
  - 默认启用 `--no-approve`、`--no-mcp` 与 `defaultProjectTrust: "never"`，防止被审查的 PR 通过 `.pi/extensions` 执行任意代码。
  - 子进程环境变量采用**严格白名单**（仅放行基础运行环境与当前 `provider` 所需密钥），`GITHUB_TOKEN`、`GH_TOKEN`、`TYPESAFE_API_KEY`、`INPUT_*` 一律不进入只读 Pi 子进程。
  - 启动 Pi 前自动擦除 `.git/config` 中可能残留的 `http.*.extraheader` 凭证，并在发布评论与 Summary 前按已知敏感值做精确子串脱敏。
- **开箱即用超大型 PR 审查**：在 Runner 内基于全量 git `merge-base` 生成分块 diff 与 base 快照，绕开 GitHub diff API 的 20000 行上限（`HTTP 406 too_large`）。
- **`submit_review` 结构化输出与双覆盖率**：通过扩展工具与 JSON Schema 强制校验审查结果，告别散文正则抠 JSON；区分 `plannedCoverage` 与 `totalCoverage`。
- **TypeSafe Jev Issue 自动分类与 PR 联动**：
  - 使用判别式模型 Jev（`POST /v1/systemone`）对 Issue 零样本分类，由纯函数 Verifier 执行白名单与置信度门限校验，低于阈值自动降级为 `needs-triage`。
  - PR 审查自动读取关联 Issue 类型与 PR 类型，动态路由审查侧重点与 `thinking` 档位，同时确保不可信的 Issue 标题与正文绝不拼入 Pi 提示词。
- **Marker 级无上限分页幂等回评**：完整分页拉取 PR 评论（无 10 页静默上限），支持 429/5xx 指数退避重试，精确更新 `<!-- pi-review:begin -->` 评论。

---

## 快速开始

### 场景 1：超大型 PR 代码审查与 Issue 联动（推荐）

在 `.github/workflows/pr-review.yml` 中引用 `devcxl/agentic-action/pr-review@main`：

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
  issues: read
  pull-requests: write

jobs:
  review:
    if: github.event.pull_request.draft == false
    runs-on: ubuntu-latest
    steps:
      - name: Checkout PR head (full history, no persisted credentials)
        uses: actions/checkout@v4
        with:
          ref: refs/pull/${{ github.event.pull_request.number }}/head
          fetch-depth: 0
          persist-credentials: false

      - name: Run Pi PR Review
        uses: devcxl/agentic-action/pr-review@main
        with:
          provider: 'half-cabbage'
          model: 'minimax-m3'
          thinking: 'high'
          fail_on: 'high'
          exclude: '**/dist/**,**/vendor/**'
          github_token: ${{ secrets.GITHUB_TOKEN }}
          typesafe_api_key: ${{ secrets.TYPESAFE_API_KEY }}
        env:
          HALF_CABBAGE_BASE_URL: ${{ secrets.HALF_CABBAGE_BASE_URL }}
          HALF_CABBAGE_API_KEY: ${{ secrets.HALF_CABBAGE_API_KEY }}
```

更多细节参见 [超大型 PR 审查文档](docs/large-pr-review.md)。

### 场景 2：Issue 自动分类（TypeSafe Jev + Verifier）

在 `.github/workflows/triage.yml` 中引用 `devcxl/agentic-action/triage@main`（无需检出代码，无需启动 Pi 进程）：

```yaml
name: Issue Triage

on:
  issues:
    types: [opened]

concurrency:
  group: triage-${{ github.event.issue.number }}
  cancel-in-progress: true

permissions:
  issues: write

jobs:
  triage:
    runs-on: ubuntu-latest
    steps:
      - name: Classify and Label Issue
        uses: devcxl/agentic-action/triage@main
        with:
          typesafe_api_key: ${{ secrets.TYPESAFE_API_KEY }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
```

仓库可通过 `.github/triage.yml` 自定义分类清单与置信度阈值（详见 [Issue 自动分类与联动设计](docs/triage-design.md)）。

### 场景 2.5：第三方代码库 / Vendor 目录安全审计（`security-audit`）

在 `.github/workflows/security-audit.yml` 中引用 `devcxl/agentic-action/security-audit@main`，可直接审计检出的第三方仓库全量代码（`audit_mode: codebase`，无需 `base_sha` 或 PR）或审计 PR 中的第三方依赖变更（`audit_mode: diff`）：

```yaml
name: Third-Party Security Audit

on:
  workflow_dispatch:
    inputs:
      target_repo:
        description: 'External GitHub repository to audit (e.g. owner/repo)'
        required: true

jobs:
  security-audit:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout third-party repository
        uses: actions/checkout@v4
        with:
          repository: ${{ inputs.target_repo }}
          path: third-party-target
          persist-credentials: false

      - name: Run Pi Third-Party Security Audit
        uses: devcxl/agentic-action/security-audit@v2
        with:
          provider: 'half-cabbage'
          model: 'deepseek-v4.1-flash'
          thinking: 'high'
          audit_mode: 'codebase'
          target_path: 'third-party-target'
          fail_on: 'high'
        env:
          HALF_CABBAGE_BASE_URL: ${{ secrets.HALF_CABBAGE_BASE_URL }}
          HALF_CABBAGE_API_KEY: ${{ secrets.HALF_CABBAGE_API_KEY }}
```

### 场景 3：通用代码库分析与结构化 Output 消费

使用根入口 `devcxl/agentic-action@main` 执行任意 Agent 任务：

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
        with:
          persist-credentials: false

      - name: Run Analysis
        id: analysis
        uses: devcxl/agentic-action@main
        with:
          model: 'openai/gpt-4o'
          tools: 'read,grep,find,ls'
          prompt: '分析 packages/ 目录下的模块划分和依赖方向，生成 Markdown 格式的架构评估报告。'
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

---

## 退出码契约（`ExitCode`）

| 退出码 | 枚举名 | 含义 |
| :--- | :--- | :--- |
| `0` | `Ok` | 正常通过、无密钥跳过（`skipped`）、或 Issue 分类低置信度安全降级（`degraded`） |
| `10` | `GateFailed` | PR 审查发现达到或超过 `fail_on` 严重级别的问题 |
| `20` | `InvalidReport` | 模型未按契约产出结构化结果，或计划内的 chunk 未完成且未开启 `allow_partial` |
| `30` | `Infrastructure` | git、网络、API 认证、或配置文件校验等基础设施故障 |

---

## 根 Action：`devcxl/agentic-action`

| 参数名称 | 类型 | 必填 | 默认值 | 描述 |
| :--- | :--- | :--- | :--- | :--- |
| `model` | String | **是** | - | 模型标识符（如 `gpt-4o`, `claude-3-7-sonnet`, 或 `provider/model`） |
| `prompt` | String | **是** | - | 执行的主要提示词或指令（支持内联文本或本地文件路径） |
| `provider` | String | 否 | `""` | 模型 Provider 名称（如 `google`, `openai`, `anthropic`, `half-cabbage`） |
| `thinking` | String | 否 | `""` | 思考级别：`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `api_key` | String | 否 | `""` | 模型 API Key（优先推荐使用对应 Provider 的环境变量） |
| `tools` | String | 否 | `""` | 工具白名单；仅当包含 `bash` 时才会向子进程保留 `GH_TOKEN` |
| `exclude_tools` | String | 否 | `""` | 排除的工具黑名单（逗号分隔） |
| `no_builtin_tools` | Boolean | 否 | `'false'` | 是否禁用所有内置工具 |
| `no_tools` | Boolean | 否 | `'false'` | 是否彻底禁用所有工具（纯文本推理模式） |
| `env_allow` | String | 否 | `""` | 额外允许透传给 Pi 子进程的环境变量名列表（逗号分隔） |
| `trust_project` | Boolean | 否 | `'false'` | 是否信任工作区 `.pi` 配置（默认 `false` 即 `--no-approve`） |
| `allow_mcp` | Boolean | 否 | `'false'` | 是否启用 MCP（默认 `false` 即 `--no-mcp`） |
| `system_prompt` | String | 否 | `""` | 覆盖系统提示词（支持内联文本或本地文件路径） |
| `append_system_prompt` | String | 否 | `""` | 追加系统提示词（支持内联文本或本地文件路径） |
| `context_files` | String | 否 | `""` | 空格、逗号或换行分隔的上下文文件路径列表（作为 `@file` 注入） |
| `prompt_template` | String | 否 | `""` | 指定提示词模板文件或目录路径 |
| `github_token` | String | 否 | `${{ github.token }}` | 当开启 `bash` 工具时暴露为 `GH_TOKEN` 的 GitHub Token |
| `pi_version` | String | 否 | `'1.4.0'` | 安装的 `@earendil-works/pi-coding-agent` 版本 |
| `mode` | String | 否 | `'text'` | 输出模式：`text` 或 `json` |
| `result_file` | String | 否 | `""` | 自定义保存原始输出的文件路径 |
| `write_summary` | Boolean | 否 | `'true'` | 是否将输出追加到 `GITHUB_STEP_SUMMARY` |

---

## 子 Action：`devcxl/agentic-action/pr-review`

| 参数名称 | 类型 | 必填 | 默认值 | 描述 |
| :--- | :--- | :--- | :--- | :--- |
| `model` | String | **是** | - | 模型标识符 |
| `provider` | String | 否 | `""` | 模型 Provider 名称 |
| `thinking` | String | 否 | `'high'` | 思考级别 |
| `api_key` | String | 否 | `""` | 模型 API Key |
| `env_allow` | String | 否 | `""` | 额外放行进 Pi 子进程的环境变量名 |
| `pr_number` | String | 否 | `${{ github.event.pull_request.number }}` | 要审查的 PR 编号 |
| `base_sha` | String | 否 | `${{ github.event.pull_request.base.sha }}` | 比对基准 SHA |
| `context_dir` | String | 否 | `""` | 自定义审查上下文输出目录（默认 `${RUNNER_TEMP}/pi-review-context`） |
| `max_chunks` | String | 否 | `'0'` | 本次最多审查的 chunk 数（`0` = 不限，真正裁剪预算） |
| `concurrency` | String | 否 | `'2'` | 分块并发审查度 |
| `allow_partial` | Boolean | 否 | `'false'` | 计划分块未全部完成时是否允许不报 `InvalidReport` |
| `exclude` | String | 否 | `""` | 额外排除的 glob 列表（逗号分隔） |
| `link_issues` | Boolean | 否 | `'true'` | 是否启用关联 Issue 与 PR 类型联动策略 |
| `include_issue_body` | Boolean | 否 | `'false'` | 是否将关联 Issue 正文以带不可信标注的文件写入 `contextDir/linked-issues/` |
| `typesafe_api_key` | String | 否 | `""` | 用于 Jev 联动的 TypeSafe API Key（绝不进入 Pi 子进程） |
| `triage_config` | String | 否 | `'.github/triage.yml'` | 分类配置文件路径 |
| `fail_on` | String | 否 | `'high'` | 门禁级别：`none`, `low`, `medium`, `high`, `critical` |
| `post_comment` | Boolean | 否 | `'true'` | 是否自动按 HTML marker 幂等发布/更新 PR 评论 |
| `comment_marker` | String | 否 | `'pi-review'` | 幂等更新所使用的 HTML Marker 名称 |
| `upload_artifact` | Boolean | 否 | `'true'` | 是否自动上传审查上下文与报告到 Workflow Artifact |
| `tools` | String | 否 | `'read,grep,find,ls'` | 审查工具集（自动追加 `submit_review`） |
| `github_token` | String | 否 | `${{ github.token }}` | 用于拉取 base 与发布评论的 Token（不会暴露给只读 Pi 子进程） |

---

## 子 Action：`devcxl/agentic-action/triage`

| 参数名称 | 类型 | 必填 | 默认值 | 描述 |
| :--- | :--- | :--- | :--- | :--- |
| `issue_number` | String | 否 | `${{ github.event.issue.number }}` | 要分类的 Issue 编号 |
| `issue_title` | String | 否 | `""` | 可选：覆盖 Issue 标题 |
| `issue_body` | String | 否 | `""` | 可选：覆盖 Issue 正文 |
| `triage_config` | String | 否 | `'.github/triage.yml'` | 分类配置文件路径或内联 YAML |
| `typesafe_api_key` | String | 否 | `""` | TypeSafe API Key（也可通过环境变量 `TYPESAFE_API_KEY` 传入） |
| `apply_label` | Boolean | 否 | `'true'` | 是否幂等将标签写入 GitHub Issue |
| `github_token` | String | 否 | `${{ github.token }}` | 用于读写标签的 GitHub Token |
| `write_summary` | Boolean | 否 | `'true'` | 是否写入 Step Summary |

---

## 环境变量参考

- **TypeSafe (Jev System One 分类模型)**:
  - `TYPESAFE_API_KEY`: TypeSafe API 密钥（仅用于 `triage` 与 `pr-review` 联动阶段，绝不暴露给 Pi 子进程）
- **Half Cabbage Provider**:
  - `HALF_CABBAGE_BASE_URL`: API 基础地址
  - `HALF_CABBAGE_API_KEY`: API 密钥（同时向前兼容 `HALF_CABBAGE_KEY`）
- **官方 Providers**:
  - `OPENAI_API_KEY`: OpenAI 密钥
  - `ANTHROPIC_API_KEY`: Anthropic 密钥
  - `GEMINI_API_KEY`: Google Gemini 密钥
