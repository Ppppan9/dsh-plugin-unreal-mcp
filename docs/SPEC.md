# DSH × Unreal Engine MCP —— 构建规范（团队共享事实源）

本文件是本次任务的**唯一事实源**。所有成员开工前必读；发现与本文件冲突的事实，先报告 Lead，不要各自发挥。

日期：2026-10-20

---

## 1. 目标

把 Epic 随 UE 5.8 发布的「Unreal MCP」能力，做成一个 **DeepSeek Harness（DSH）可安装的插件包（bundle）**，
让 DSH 里的 agent 能直接驱动活的 Unreal Editor。

参考物是 Epic 官方的 **Claude Code 侧插件** `unreal-engine-skills-for-claude-code`（MIT，本地已有完整源码：
`/Users/houtao/Minimax/rea_ue/unreal-engine-skills-for-claude-code-plugin/`）。
它 = 995 行 Markdown（3 个 skill + 2 个 reference）+ 1 个 84 行 bash SessionStart hook，
**不含任何 `.mcp.json`**，也不含任何二进制。

我们要做的是**等价的 DSH 原生实现**，不是把 bash hook 照搬。

---

## 2. 已被证实的关键事实（不要重复验证，直接用）

### 2.1 UE 引擎侧（Epic 闭源，随引擎分发）

- 插件名 `ModelContextProtocol`（友好名 Unreal MCP），UE 5.8 起随引擎发布，**闭源 + NoRedist**。
- 传输：**只有 HTTP + SSE**，地址 `127.0.0.1:<port>/mcp`，默认端口 `8000`。**不支持 stdio / WebSocket**。
- 默认 `bEnableToolSearch=true` → `tools/list` **只返回 3 个元工具**：
  `list_toolsets` / `describe_toolset` / `call_tool`。
  真正的几百个工具通过 `call_tool` 在服务端派发，**不出现在 tools/list**。
- `initialize` 返回普通 JSON + `Mcp-Session-Id` 响应头；后续每个请求必须回传该头。
- `notifications/initialized` → 202 空响应。
- `tools/call` 返回 **`text/event-stream`**（`event: message` + `data: <jsonrpc>` 帧），不是普通 JSON。
- 端口解析优先级：命令行 `-ModelContextProtocolPort=N` → 设置 CDO → 默认 8000。
- `call_tool` 的坑（派发语义）：
  - `toolset_name` 必须用 `list_toolsets` 返回的**全限定名**（如 `editor_toolset.toolsets.scene.SceneTools`）。
  - `tool_name` 必须用**短名**（`get_current_level`）；传全限定名 → `Unknown tool`。
  - `TOptional` 参数**必须显式传 `null`**，省略报 `input param "X" needs a default value`。
  - schema 的 `required` 是字面语义；"任意"要传 `""` / `[]`。
  - 属性名 camelCase 且保留 UE 的 `b` 前缀（`bUseTemperature`）。
  - 对象引用统一 `{"refPath": "<soft object path>"}`。
  - `ObjectTools.set_properties` 的 `values` 是 **JSON 字符串**。
  - 基础类型结果包 `{"result": ...}`，文本内容块里是 `{"returnValue": ...}`。
- 控制台命令：`ModelContextProtocol.StartServer [port]` / `StopServer` / `RefreshTools` /
  `GenerateClientConfig <ClaudeCode|Cursor|VSCode|Gemini|Codex|All>`。
- 安全：无认证层，只绑 loopback，拒绝非 loopback Origin。同机同用户任意进程可连。

### 2.2 DSH 侧（已实测确认，见 §7 证据）

- **`@deepseek-ai/dsh-mcp-client` 用官方 `@modelcontextprotocol/client` 2.2.0 的
  `StreamableHTTPClientTransport`**。**已实测**：它对 UE 的线路怪癖（session 头、SSE 的 tools/call、
  无 GET SSE 流）全部正确处理，`initialize`→`tools/list`→`tools/call` 全通。
  → **不需要写 stdio 桥/代理**。这是本方案能成立的根本原因。
- MCP 工具在模型侧的名字是 `mcp__<serverName>__<rawName>`，即 `mcp__unreal__call_tool`。
- mcp-client 配置字段：`serverName` / `transport: streamable-http` / `url` / `headers` /
  `toolCallTimeoutMs`（默认 60000）/ `failOnStartupError`（默认 false）/
  `reconnect.{enabled,initialDelayMs,maxDelayMs,maxAttempts}`（默认 true, 500, 30000, 10）。
- **连接失败不会拒绝启动**（`failOnStartupError: false`），会按 backoff 重连；
  10 次全失败后**注销工具**并要求 reload/restart。→ 我们的 bundle 要调大 `maxAttempts`。
  注意：UE 的 `tools/call` 会阻塞到 game thread 跑完，所以 `toolCallTimeoutMs` 要给足（建议 300000）。
- **`tools/list` 只来 3 个元工具**这一点对 DSH 完全无害：DSH 会把它们原样注册成 3 个工具，
  agent 靠 skill 里的三步契约去 `list_toolsets`→`describe_toolset`→`call_tool`。
  → **skill 里的使用契约是必需品，不是装饰**。
- DSH skills 的发现根（rank 从高到低）：
  `100 <project>/.dsh/skills` → `200 <project>/.agents/skills` → `300 Config.customSkillDirs`
  → `400 <dshHome>/skills` → `500 <agentsHome>/skills` → `600 bundledSkillDir`。
  项目根 = 最近的 `.git` 祖先（**注意：UE 工程通常没有 `.git` 在根上，这条要专门处理**）。
- DSH 的 skill provider 接口（见 `@deepseek-ai/dsh-skill`，已读源码）：
  ```js
  ctx.skills.registerProvider(() => ({
    name: '<providerName>',
    list: () => Promise.resolve([candidate]),
    get: (candidate) => Promise.resolve(definition),
  }))
  ```
  candidate 字段：`name`(kebab-case) / `description`(非空) / `invocation:{modelInvocable,userInvocable}` /
  `provider`(=provideName) / `source`(string) / `rank`(number) / `locator` / `resourceBase`。
  definition 额外要求 `content`(string)。`BUNDLED_SKILL_RANK = 600` 从 `@deepseek-ai/dsh-skill` 导出。
  可照抄 `@deepseek-ai/dsh-skill-badge` 的实现（已解包在 `/tmp/dsh-asar/skill-badge.js`）。
- DSH system prompt：`ctx.systemPrompt.section({ name, order, text, interpolate })`，
  `text` **可以是函数**（每次 assembly 求值）；顺序表里 `MCP_SERVERS: 3100`。
- DSH **没有 SessionStart hook**。等价物是上面的动态 prompt section（按 session cwd 判定）。

### 2.3 本机环境（重要限制）

- **本机没有 UE 5.8，也没有引擎二进制**（只有 `~/Library/Application Support/Epic/UnrealEngine/5.5/Saved`
  残留和一个 Epic Games Launcher app）。→ **无法做真机验证**，必须在文档里如实声明。
- 已有**高保真 UE wire mock**：`/Users/houtao/Minimax/rea_ue/minimax-ue-mcp/mock-unreal-mcp.mjs`
  （严格复刻 §2.1 的线路行为，含 SSE、session 头、三个元工具、两个真实坑）。
- DSH 运行时：`/Applications/DeepSeek Harness.app`，版本 `0.2.1-rc.2`，Node `24.21.0`。
  CLI：`/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`。
  必须用 `ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"` 跑 Node。
- 当前 profile：`desktop`（`~/.dsh/profiles/desktop`），**被 Electron 独占管理**，
  不许手工改它的 `package.json` / `cordis.patch.yml`，也不许 `dsh plugin --profile desktop`。
  → 测试必须用**独立 scratch profile**，不要碰用户的 desktop profile。
- asar 里的包可以这样取：
  ```bash
  cd /tmp/xxx && npx --yes @electron/asar extract-file \
    "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar" "dsh/node_modules/@deepseek-ai/<pkg>/<path>"
  ```
  （注意 asar 根前缀是 `dsh/`；`cat`/`ls`/ripgrep 打不开 asar，只有 Node 的文件读能开）

---

## 3. 交付物（必须全部落地在 `/Users/houtao/Deepseek Harness/unreal-mcp-dsh/`）

```
unreal-mcp-dsh/
├── SPEC.md                  ← 本文件
├── README.md                ← 面向用户：安装、使用、边界、未验证声明
├── REPORT.md                ← 面向验收：做了什么、怎么验的、证据、剩余未知
├── plugin/                  ← 可安装的 bundle 包（交付主体）
│   ├── package.json
│   ├── cordis.patch.yml
│   ├── index.js             ← Host 插件：skill provider + UE 项目探测 prompt section
│   ├── skills/
│   │   ├── unreal-mcp/SKILL.md
│   │   ├── unreal-mcp/references/setup.md
│   │   ├── unreal-mcp/references/operations.md
│   │   ├── create-toolset/SKILL.md
│   │   └── unreal-skill/SKILL.md
│   ├── locale/en.json
│   ├── locale/zh.json
│   ├── icon.svg
│   ├── LICENSE-Epic-Games-MIT.txt
│   └── NOTICE.md
└── tests/                   ← 验证工程（不需要 UE）
    ├── mock-unreal-mcp.mjs
    ├── wire-contract.test.mjs   ← 用 DSH 自己的 MCP SDK 打 mock，断言线路契约
    ├── plugin-unit.test.mjs     ← 用假 ctx 跑 plugin apply()，断言注册内容
    ├── integration.test.mjs     ← 真 cordis Context + 真 dsh-mcp-client + mock，断言 mcp__unreal__* 工具
    └── run-all.sh
```

**bundle 的形态**：一个「配置 + Host 插件」混合 bundle。
- MCP 连接那一行直接用官方的 `@deepseek-ai/dsh-mcp-client`（**不要自己写 MCP 客户端**）。
- 我们自己的 Host 插件只负责两件事：
  1. 注册 3 个 bundled skill（从包内 `skills/` 读，不用落盘到用户目录）；
  2. 按 session 工作目录探测「这是不是一个 UE 工程」，是则往 system prompt 追加**一句**上下文
     （对应 Epic 那个 sessionStart hook 的语义）。
- 判据（照抄 Epic hook 的判定，并补 DSH 特有的一条）：
  - 向上找根，marker = `GenerateProjectFiles.bat|.sh|.command` 或任一 `*.uproject`；
  - **裸 `Engine/` 目录不算 marker**（Epic 源码里的注释明确警告过这个坑，必须保留）；
  - 注意 DSH 的项目根是「最近 `.git`」而 UE 工程常常没有 `.git`，所以我们的探测**必须自己向上走**，
    不要用 DSH 的 projectRoot。

---

## 4. 每一项的可验证验收标准

| 编号 | 验收项 | 怎么验 |
|---|---|---|
| A1 | bundle 能被 DSH 当作 bundle 解析 | `package.json` 的 `dsh.bundle.patch` 指向存在的 patch；`node --check` 全部 JS |
| A2 | patch 能组合进 profile 树 | scratch profile 里 `dsh --profile <name> --dump-config` 出现对应行 |
| A3 | 3 个 skill 出现在技能目录 | 单元测试调 `apply()`，断言 `registerProvider` 返回的 candidate 名字/描述/rank |
| A4 | UE 工程能探测到、非 UE 目录探测不到 | 单元测试用临时目录构造 `.uproject` / `Engine/` / 普通目录 |
| A5 | DSH 的 MCP 客户端能连上 UE 线路 | `wire-contract.test.mjs` 打 mock，断言 session 头 + SSE + 3 元工具 + 两个真实坑 |
| A6 | 真 mcp-client 插件能把 UE 工具注册成 `mcp__unreal__*` | `integration.test.mjs`：真 cordis Context + 真 mcp-client + mock |
| A7 | 端到端 `list_toolsets`/`call_tool` 返回值可解析 | integration 测试里实际调用并解析 |
| A8 | 文档如实声明未在真 UE 上验证 | 人工检查 README / REPORT |

---

## 5. 分工与写作用域（严禁越界写）

| 成员 | 负责 | 允许写 |
|---|---|---|
| lead | SPEC、REPORT、最终整合、验收 | `SPEC.md`、`REPORT.md`、必要时修任何文件 |
| `bundle-author` | `plugin/` 全部文件（manifest/patch/index.js/skills/locale/icon/license/notice） | `plugin/**` |
| `verifier` | `tests/` 全部文件、跑通并给结果 | `tests/**` |

两边都只写自己目录。`README.md` 归 lead。发现需要改对方目录，先消息 Lead。

---

## 6. 风格与质量要求

- 中文注释/文档为主（用户是中文语境的游戏团队），代码标识符英文。
- 所有 Markdown 交付物要有清晰的小标题、表格、代码块；不要空话。
- 不要把 995 行原文整坨抄进来：**按 DSH 的机制改写**（例如把 "unreal-mcp-proxy" 的说明改成
  "DSH 不需要 proxy"），并保留 Epic 的 MIT 许可与 NOTICE 里的改动清单。
- `plugin/index.js` 必须是**纯 ESM、零依赖**（除 `@deepseek-ai/dsh-skill` 的常量外），
  能用 `node --check` 通过；不要引入构建步骤。
- 不要写死端口：默认 8000，允许 `!!js` 从 `process.env.UNREAL_MCP_PORT` 覆盖。

---

## 7. 已有证据（Lead 已跑过，成员可信）

```
# DSH 的 MCP SDK 打 UE 线路 mock（含无 GET SSE 的变体），0 失败
CONNECT OK in 28 ms; protocolVersion= 2025-06-18
TOOLS: [ 'list_toolsets', 'describe_toolset', 'call_tool' ]
CALL list_toolsets content: [{"type":"text","text":"[{\"name\":\"editor_toolset...\"}]"}]
CALL call_tool content: [{"type":"text","text":"{\"returnValue\":{\"ok\":true,...}}"}]
CLOSED
```
命令复现：`ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" /tmp/wiretest.mjs http://127.0.0.1:8123/mcp`

结论：**DSH 原生 streamable-http 客户端与 UE 5.8 的线路契约兼容**，无需桥接。
