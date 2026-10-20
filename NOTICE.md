# NOTICE

`dsh-plugin-unreal-mcp` 是一个 **DSH（DeepSeek Harness）bundle**，把 Epic Games 的「Unreal MCP」
能力接到 DSH 上。它由两部分组成：

1. **配置**：`cordis.patch.yml` 里的一行，复用官方的 `@deepseek-ai/dsh-mcp-client` 直连
   Unreal Editor 进程内的 `ModelContextProtocol` server（HTTP + SSE，默认 `127.0.0.1:8000/mcp`）。
2. **本 bundle 自己的 Host 插件**（`index.js`）：注册 3 个 bundled skill，并按 session 工作目录
   探测 UE 工程、往 system prompt 追加一句上下文。

**本 bundle 不包含任何 Unreal Engine 代码，也不包含 Epic 的 `unreal_mcp_proxy` 二进制。**
引擎侧的 MCP server 由 UE 5.8+ 随引擎分发（闭源，NoRedist），本 bundle 只是它的客户端。

---

## 派生物：`skills/` 下的 Markdown

`skills/unreal-mcp/`、`skills/create-toolset/`、`skills/unreal-skill/` 三个 skill 目录
**派生自 Epic Games 的开源 Claude Code 插件**：

| 项 | 值 |
|---|---|
| 上游 | `EpicGames/unreal-engine-skills-for-claude-code-plugin` |
| 上游版本 | `3.1.1`（commit `a6aa73ada02a9fb1f5415bec491f9942c519b297`） |
| 上游许可 | MIT，`Copyright (c) 2026 Epic Games, Inc.` |
| 上游文件 | `skills/unreal-mcp/SKILL.md`、`skills/unreal-mcp/references/setup.md`、`skills/unreal-mcp/references/operations.md`、`skills/create-toolset/SKILL.md`、`skills/unreal-skill/SKILL.md`，以及 `hooks/unreal-context.sh`（仅行为被移植，代码未复制） |
| 本 bundle 许可 | MIT，见 `LICENSE-Epic-Games-MIT.txt`（保留上游版权声明） |

### 改了什么

**`skills/unreal-mcp/SKILL.md`**

- 工具名改成 DSH 的模型侧名字：`mcp__unreal__list_toolsets` / `mcp__unreal__describe_toolset` /
  `mcp__unreal__call_tool`，并写清「发现 → 描述 → 派发」三步契约原本的 `list_toolsets` /
  `describe_toolset` / `call_tool` 与这三者的对应关系。
- 删掉「连接可能显示为 `unreal-mcp-proxy`」整段，替换为「DSH 不需要 proxy，也不要安装」并说明原因
  （DSH 的 MCP 客户端原生支持 Streamable HTTP，能正确处理 UE 的 session 头 / SSE / 无 GET SSE 流）。
- 新增「读结果：text 里是一段 JSON 字符串」一节：UE 不返回 `structuredContent`，
  `content[0].text` 本身是 JSON 字符串，需要 `JSON.parse` 后取 `returnValue`。
- 把「很多工具返回 status 而不抛异常」改写成 DSH 语境：**DSH 会把 MCP `isError` 转成工具调用抛错**，
  所以错误是异常而不是返回值；但 **transport 成功 ≠ 操作成功**，parse 完仍要读 status 字段。
- 新增「高频报错」表（`Unknown tool` / `input param "X" needs a default value` /
  属性名大小写与 `b` 前缀 / `values` 是 JSON 字符串 / `refPath` 形状），并补上「慢是正常的」
  （`call_tool` 阻塞到 game thread 跑完，本 bundle 超时设为 300000ms）。
- 安全规则、项目级 Agent Skill、配套 skill 三节保留原意。
- 描述（frontmatter `description` 与 `index.js` 里的路由描述）改写以适配 DSH 的工具发现模型。

**`skills/unreal-mcp/references/setup.md`**

- 删除「生成 `.mcp.json`」「可选安装 proxy」两节 —— DSH 的 MCP 配置是 profile 的
  `cordis.patch.yml`，由本 bundle 写好；`ModelContextProtocol.GenerateClientConfig ClaudeCode`
  对 DSH 无意义。
- 保留 `ModelContextProtocol` + `AllToolsets` 双插件必需、`bAutoStartServer` 的 ini 片段、
  端口解析优先级。
- 新增「DSH 侧换端口怎么办」（`UNREAL_MCP_PORT` 环境变量）与 DSH 版的验证步骤。

**`skills/unreal-mcp/references/operations.md`**

- 删除整节 proxy 恢复流程。
- 新增「DSH 侧的连接语义」：`failOnStartupError: false` 不拦启动、退避重连、
  `maxAttempts` 调到 100000、`toolCallTimeoutMs` 300000、**没有 `unreal_mcp_status` 工具**
  （它是 proxy 的程序集里的）。
- 排障矩阵改成「三种坏法」（连接层 / 编辑器侧拒绝 / 派发与 toolset），并明确错误是**抛错**。
- 补上逆向分析报告里真机踩出来的坑（CrashReporter 占端口、`FocusOnActors` 对 Cesium 崩、
  macOS 上 `bRemoteExecution` 卡死、崩溃日志路径、`open *.uproject`），
  以及 `execute_tool_script` 的真实沙箱边界（白名单 6 模块、无 `unreal`、只读 `open`、transaction scope）。

**`skills/create-toolset/SKILL.md`**

- 保留全部技术内容（C++ / Python 双路径、文档规范、异步工具、转换器、错误处理、测试）。
- 「通过 MCP 跑测试」一节改成 DSH 工具名，并补上「结果在 `content[0].text` 里要 parse」。
- 编译提示改成用 `mcp__unreal__call_tool` 派发 `LiveCodingToolset.CompileLiveCoding`，
  并注明「慢是正常的，不要重试」。

**`skills/unreal-skill/SKILL.md`**

- 开头新增「两种 skill 别搞混」的提示框：Unreal Agent Skill（注册在 MCP server 里）
  vs DSH harness skill（注册在 DSH 里，`.dsh/skills` 等）。
- 把原文里「distinct from Claude Code's harness skills under `.claude/skills/`」改成 DSH 的对应路径。
- MCP 调用补上 DSH 工具名与「text 里是 JSON 字符串」的提醒。

**`index.js`（行为移植，非代码复制）**

`hooks/unreal-context.sh` 的语义被移植成 DSH 的 prompt section：

- 判定逻辑完全照抄：从 cwd 向上遍历，marker = `GenerateProjectFiles.bat|.sh|.command`
  或任一 `*.uproject`；**裸 `Engine/` 目录不算 marker**（Epic 源码注释里明确警告过：
  UE 源码树有 `Engine/Source/Runtime/Engine`，从 Runtime module 向上会在 `Source/Runtime`
  短路误判成工程根）；有 `Engine/` 目录时 `project_type = engine`，否则 `game`。
- 注入文本同样刻意极短（一次一句），但改为 DSH 的注册方式（每次 assembly 求值的 prompt section），
  而不是 Claude Code 的 `SessionStart` hook。
- 删掉 `.mcp.json` 检测与「去跑 `GenerateClientConfig`」的提示（DSH 不适用）。
- 新增有界 FIFO(256) 探测缓存 —— DSH 的 `text()` 每轮 assembly 都会被求值，
  而探测要多次 `existsSync` / `readdirSync`。
- 上游 bash 脚本的动态内容做了 JSON 转义（防止 hook 输出坏 JSON）；DSH 侧不需要，
  因为文本是结构化字段而不是 JSON 片段。

---

## 未派生自上游的部分

以下文件是本 bundle 原创，未复制上游任何内容：

- `index.js`（DSH Host 插件）
- `cordis.patch.yml`
- `package.json`
- `locale/en.json`、`locale/zh.json`
- `icon.svg`（自绘；不包含 Epic 的 logo、UE 商标的图形化表示，也不含 Fortnite / Unreal 的官方图标）
- `NOTICE.md`（本文件）

## 关于「本插件零依赖」这条设计约束

`index.js` **不 import 任何 `@deepseek-ai/*` 包**，`package.json` 也**不声明** `@deepseek-ai/*` 的
`dependencies` / `peerDependencies`。这不是洁癖，实测结论：

- profile 里安装的普通 JS 插件**无法 `import` DSH 的包**。profile 的 `node_modules` 只包含该插件自己
  声明的依赖，Node 的 ESM 解析器从插件文件位置向上找不到 DSH 安装目录。实测错误：
  ```
  ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-skill'
    imported from <profile>/node_modules/<plugin>/index.js
  ```
  DSH 的 two-anchor 解析只对 **cordis patch 里的 `name` 字段**（loader 走的那条 import）生效，
  **不覆盖插件文件内部的 import 语句**。
- 所以 `BUNDLED_SKILL_RANK = 600` 在 `index.js` 里内联（注释里对齐说明）。
- 反过来，**patch 里的 `name: '@deepseek-ai/dsh-mcp-client'` 是能正常解析的**（loader 层），
  所以直接复用官方 mcp-client 没有问题 —— 这条已实测。
- 若声明 `@deepseek-ai/*` 依赖，pnpm 会去 registry 装，可能装不到 / 版本不匹配，反而让安装失败。

## 自测记录（可复现）

在写这份 NOTICE 时，插件在**真实 DSH runtime**（`ELECTRON_RUN_AS_NODE=1` +
`/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness`）上跑过：

| 验证 | 方式 | 结果 |
|---|---|---|
| 语法 / 零第三方 import | `--check index.js` + 读 import 行 | 通过，只有 `node:fs` / `node:path` / `node:url` |
| patch YAML 用 DSH 自己的方言解析 | `js-yaml` + 复刻的 `!!js` Type + `JSON_SCHEMA` | 13 项断言全过 |
| patch 的 client 行能过真 `Config` schema | `@deepseek-ai/dsh-mcp-client` 导出的 `Config` | 通过，默认值补齐正确 |
| provider 在**真 cordis + 真 skill 注册表**上工作 | `new Context()` + `dsh-skill` 的 `SkillRegistry` | 3 个 skill 可 `list` / `get`，`complete: true`，卸载后清空 |
| prompt section 在**真 `dsh-system-prompt`** 上工作 | 真实 `section()` / `assemble()` / `renderPrompt()` | order=3105，`interpolate:false` 保留，未命中时不渲染 |
| 没有 `systemPrompt` 服务时插件仍能装载 | 只 provide `skills` | fiber `state=2`，skills 正常注册 |
| bundle 的 `files`/`exports` 覆盖全部运行时文件 | `npm pack --dry-run` | 13 个文件全部打进去 |

**没验证**：真实 UE 5.8 编辑器（本机没有 UE）。引擎侧行为来自 Epic 官方文档 +
第三方真机实测记录 + mock 复刻，见团队 `SPEC.md` §7 与 `REPORT.md`。

## 商标

Unreal、Unreal Engine、Unreal Editor 是 Epic Games, Inc. 的商标。
本 bundle 与 Epic Games 无隶属关系，未经其背书。

## 没有验证到的部分

诚实声明：本 bundle 的**线路契约**是在 UE 5.8 的高保真 wire mock 上验证的
（session 头、SSE 的 `tools/call`、三个元工具、两条真实报错路径），
**没有在真实的 UE 5.8 编辑器上跑过** —— 构建机上没有安装 UE。
引擎侧的结论来自 Epic 官方文档 + 第三方在 5.8 上的实测记录，见团队 `SPEC.md` §7 与 `REPORT.md`。
