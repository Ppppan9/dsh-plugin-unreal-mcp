# 交付报告：DSH × Unreal Engine MCP

日期：2026-10-20
交付形态：可安装的 DeepSeek Harness bundle（`dsh-plugin-unreal-mcp` v1.0.0）+ 无 UE 依赖的验证工程
参考物：Epic 官方 `unreal-engine-skills-for-claude-code`（MIT，UE 5.8 官方市场插件）

---

## 1. 做了什么（一句话）

把 Epic 随 UE 5.8 发布的 **Unreal MCP**（编辑器进程内的 HTTP/SSE MCP Server）
接进 DeepSeek Harness：一个 bundle 里放「MCP 连接配置 + 3 个 skill + UE 工程探测」，
**复用官方 `dsh-mcp-client`，不写任何代理/桥接程序**。

---

## 2. 关键结论（三个，都有实测支撑）

> **验证状态更新（2026-10-20 晚）**：本机已安装 **Unreal Engine 5.8** 并完成真机验证，
> 结论从「基于 mock + 第三方报告」升级为「真机实测」。真机与第三方报告有 3 处差异，
> 已在 §2.6 单列。§2.1 的 mock 结论保留（它证明的是 DSH 客户端的线路兼容性）。

### 2.1 DSH 不需要 Epic 的 `unreal_mcp_proxy` —— 这是整个方案能成立的原因

Epic 提供 proxy 的唯一原因：**引擎不支持 stdio**，而很多 MCP 宿主只认 stdio。
DSH 的 `dsh-mcp-client` 底层是官方 MCP SDK 2.2.0 的 `StreamableHTTPClientTransport`，
它原生支持 UE 的 `Mcp-Session-Id` 会话头机制。

**真机复现**（UE 5.8 + 真编辑器，`UE5McpTest` 工程）：

| 步骤 | 真机结果 |
|---|---|
| `initialize` | 200，`protocolVersion: 2025-06-18`，下发 `mcp-session-id` |
| `notifications/initialized` | 202 |
| `tools/list` | 200，恰好 3 个元工具 |
| `tools/call list_toolsets` | 200，**67 个 / 55 个**（随工程启用的插件变化） |
| DSH 插件注册 | `mcp__unreal__list_toolsets` / `describe_toolset` / `call_tool` |
| 真实只读调用 | `get_current_level` → `{"returnValue":"/Temp/Untitled_1"}` |
| 真实写调用 | `add_to_scene_from_class` → actor 145→146 |
| 真实删除 | `remove_from_scene` → 146→145（清理干净） |
| 真实截图 | `CaptureViewport` → 7.1 MB PNG，视口渲染正常 |

→ **DSH 原生客户端与 UE 5.8 真引擎完全兼容，proxy 是多余的。**

**mock 侧结论保留**（证明线路兼容性，不依赖真机）：

```bash
dsh plugin --profile finaltest add "link:.../unreal-mcp-dsh/plugin"
dsh --profile finaltest
```

mock 服务端观测到的真实请求序列（`--log` JSONL）：

| seq | method | 状态 | 说明 |
|---|---|---|---|
| 1 | `server/discover` | 400 | SDK 的 era 探测，无 session → 400（**正常**） |
| 2 | `initialize` | 200 | 请求 `2025-11-25`，服务端降级，**下发 session** |
| 3 | `notifications/initialized` | 202 | 带 session 头 |
| 4 | `GET /mcp` | 404 | SDK 自动开的 SSE 流；mock 模拟不提供 GET 流的 build |
| 5 | `tools/list` | 200 | 返回 3 个元工具 |

### 2.2 UE 默认 Tool Search 模式下，3 个元工具 + skill 契约是必需品

`bEnableToolSearch=true`（默认）时 `tools/list` **只有**
`list_toolsets` / `describe_toolset` / `call_tool`，
几百个真工具靠 `call_tool` 在服务端派发、**永不出现在 tools/list**。
所以 skill 里的「发现 → 描述 → 派发」三步不是装饰，是唯一的可用路径。

DSH 侧工具名（已实测注册进真 registry）：

```
mcp__unreal__list_toolsets
mcp__unreal__describe_toolset
mcp__unreal__call_tool
```

### 2.3 真机会话验证（DSH 重启后，2026-10-20 下午）

对**所有主要 toolset** 做了逐项功能调用，结论如下。

**完整跑通（创建/读取/修改/删除闭环）**：

| toolset | 实测内容 |
|---|---|
| SceneTools | 创建/删除 actor、`find_actors`、`get_current_level`、`remove_from_scene` |
| ObjectTools | `list_properties` / `get_properties` / `set_properties`（双层 JSON 已验证） |
| ActorTools | `get_actor_transform` / `set_actor_transform`（位置+旋转+缩放全部生效）、`set_label` / `get_label`、`get_components`、`look_at` |
| EditorAppToolset | `StartPIE` / `StopPIE`、`CaptureViewport`、`OpenEditorForAsset` |
| LogsToolset | `GetLogEntries` 按 category + pattern 过滤，读到蓝图 PrintString 输出 |
| BlueprintTools | 创建蓝图、`add_variable`（4 种类型）、`add_function_graph` + `add_function_param`、`write_graph_dsl`、`compile_blueprint`（`warnings_as_errors=true`）、`read_graph_dsl` 回读 |
| MaterialTools | `create_material`、`add_expression`、`get_expressions`、`recompile`、`list_expression_classes` |
| MaterialInstanceTools | `create`、`set_scalar_parameter`、`get_scalar_parameter`、`list_parameters` |
| UMGToolSet | `CreateWidgetBlueprint`、`AddWidget`、`GetWidgets`（widgetCount）、`GetWidgetTreeDepth`、`CompileWidgetBlueprint` |
| SequencerTools | `create_level_sequence`、`get/set_playback_range`、`add_root_folder` / `get_root_folders`、`add_track_to_sequence` / `get_tracks_on_sequence` |
| ProgrammaticToolset | `execute_tool_script` 编排多工具；`get_execution_environment`；沙箱边界验证 |
| AssetTools | `save_assets` 把蓝图落盘到 `.uasset` |

**本轮新发现的行为（已写进 skill）**：

1. **各 toolset 参数名风格不统一**——UMGToolSet 用 camelCase（`folderPath` / `assetName` / `parentClass`），
   其它 toolset 用 snake_case；SequencerTools 还有独特命名（`package_path` / `actor_class_path` / `track_type`）。
2. **工具名会和直觉不同**——材质创建是 `create_material`，Blueprint 创建才是 `create`。
3. **DSL 的布尔变量 setter 会剥掉 `b` 前缀**——变量 `bEnabled` 对应节点 `SetEnabled`。
4. **DSL 的 `(switch ...)` 不生成节点**（写入返回成功但回读缺失）；
   `(bind ...)` 作为 event 首条可能清空整个图。→ 每次 write 后必须回读核对。
5. **Python 沙箱规则**：入口必须是 `def run():`；`execute_tool` 第二参是 JSON 字符串；
   返回已是解析后的 dict（不要再 `json.loads`）；白名单仅 6 个模块（`math`/`re`/`json`/`time`/`datetime`/`copy`），
   `import unreal` 被明确拒绝。

**仅枚举工具面、未做完整功能调用**：Niagara（46 个工具）、
StateTree、ControlRig、PCG、Dataflow、GameplayAbility、GameplayTags、StringTable、Texture、
DataRegistry、SemanticSearch、Plugin/GameFeatures、ConfigSettings、Conversation、
AutomationTest、AnimationAssistant、SkeletalMesh、StaticMesh、WidgetToolSet 等。
这些工具面通过 `describe_toolset` 与 `list_toolsets` 确认存在。

### 2.4 全功能验证（2026-10-20 晚，UE 5.8 真机）

重启 DSH 后在新会话里直接验证插件自动加载，并用 MCP 工具完成了一次真实分析任务：

| 验证 | 结果 |
|---|---|
| 重启后插件自动生效 | ✅ 新会话里 `mcp__unreal__*` 三工具直接可用，无需重装 |
| 场景规模 | 145 个 actor |
| 光照相关 actor | 5 个（DirectionalLight / SkyLight / SkyAtmosphere / ExponentialHeightFog / VolumetricCloud） |
| DirectionalLight 属性 | `intensity=6`、`temperature=6500`、`castShadows=true`、`bUseTemperature=true`、`mobility=Movable` |
| SkyLight 属性 | `intensity=1`、`sourceType=SLS_CapturedScene`、`bRealTimeCapture=true`、`mobility=Movable` |
| 真实写操作（属性） | `set_properties` 把 intensity 6 → 8.5，复读确认生效，再改回 6 |
| 视口截图 | `CaptureViewport` 返回 6.6 MB PNG，相机坐标与 FOV=90 一并返回 |

**本轮新发现的两个真机行为（已写进 skill）**：

1. **`ObjectTools` 的 `returnValue` 是双层 JSON 字符串** —— 要 parse 两次。
   `get_properties` 得到值对象，`list_properties` 得到 `{属性名: schema}` 映射
   （**key 就是可用属性名**，这是安全拿属性名的唯一正路）。
2. **一个错的属性名会让整次调用失败**，且返回的是**纯文本**不是 JSON：
   ```
   GetObjectProperties on '...LightComponent0' (DirectionalLightComponent):
   the following properties could not be read: attenuationRadius, sourceAngle
   ```
   此时 `isError` 甚至可能是 `undefined`，直接 `JSON.parse` 会抛 `Unexpected token 'G'`。
   → 正确顺序永远是 `list_properties` → 挑真实名字 → `get_properties`。
3. **组件引用名不统一**：DirectionalLight 是 `.LightComponent0`，SkyLight 是 `.SkyLightComponent0`。
   稳妥做法是先读 actor 的 `lightComponent` 属性拿 refPath。

**toolset 数量随工程变化**：同一台机器上实测过 **67 个**（UE5McpTest 首次）和 **55 个**
（重启后加载的工程/插件组合不同）。文档已改为「数十个，随工程变化」，不再写死数字。

### 2.5 两个影响 skill 文案的 DSH 侧行为（实测，已写进 skill）

| 事实 | 证据 | 对 skill 的影响 |
|---|---|---|
| **MCP `isError` 在 DSH 里被转成抛异常** | `dsh-mcp-client` 的 `createExecutor`：`if (result.isError === true) throw new Error(text)` | 排障段写"调用会失败/抛错"，不能写"检查 isError 字段" |
| **UE 的返回值没有 `structuredContent`** | 实测返回对象 `keys = ["content"]`，`structuredContent === undefined`；`content[0].text` 是 `'{"returnValue":{...}}'` 字符串 | skill 必须教 agent 对 `content[0].text` 做 `JSON.parse` 再取 `returnValue` |

两条由 Lead 与 verifier **各自独立复现，结论一致**。

### 2.6 真机 vs 第三方报告的差异（**真机实测纠正**）

本机装上 UE 5.8 后逐条核对，发现流传的逆向报告有 3 处与真实引擎不符。
**这些差异会直接导致 agent 写错代码**，已全部按真机修正 skill 文案。

| # | 第三方报告说法 | 真机实测（UE 5.8 / macOS） | 影响 |
|---|---|---|---|
| 1 | `tools/call` 返回 `text/event-stream` | ❌ 返回 **`application/json;charset=utf-8`** | 对 DSH 无影响（两种都能处理），但文档不能写错 |
| 2 | `list_toolsets` 返回 JSON 数组 | ❌ 返回 **Markdown 列表文本**：`- <全限定名>: <描述>` | **agent 若 JSON.parse 必错**。这是本次最重要的修正 |
| 3 | `describe_toolset` 返回 JSON 数组 | ✅ 返回 **JSON 对象** `{name, version, description, tools[]}` | 与报告一致 |
| 4 | `tool_name` 用裸短名 | ✅ 短名，但要**去掉 `<toolset_name>.` 前缀** | 已写清推导规则 |
| 5 | 缺 `TOptional` 报 `needs a default value` | ✅ 一致 | 已验证 |
| 6 | （报告未提）缺必填参数 | 另有报错 `input params are required by the function input schema ..., but incoming ... is empty` | 已单列，并说明「报错文本自带 schema，照着补最快」 |
| 7 | （报告未提）`serverInfo` | 真机返回空：`{"name":"","title":"","version":""}` | 无法从握手判断引擎版本 |
| 8 | （报告未提）`ObjectTools` 返回值层级 | `returnValue` 是**嵌套 JSON 字符串**，要 parse 两次 | 只 parse 一次会拿到字符串而非对象 |
| 9 | （报告未提）属性名错误 | 一个错名 → 整调用失败，且返回**纯文本**（非 JSON） | 必须 `list_properties` 先拿真实属性名 |
| 10 | （报告未提）toolset 数量 | 同机实测 67 / 55 两种，随工程启用的插件变化 | 文档不能写死数字 |

**三个工具的真实返回格式**（真机逐个确认）：

| 工具 | `content[0].text` 格式 | 读法 |
|---|---|---|
| `list_toolsets` | Markdown 列表 | 按 `/^- ([^:\n]+): /` 解析，**不要 JSON.parse** |
| `describe_toolset` | JSON 对象 | `JSON.parse` |
| `call_tool` | JSON 字符串 | `JSON.parse` → 取 `.returnValue` / `.result` |

三者都**没有 `structuredContent`**（`keys = ["content"]`）。

---

## 3. 交付物

```
unreal-mcp-dsh/
├── SPEC.md                  团队共享事实源（含全部取证结论）
├── README.md                面向用户：安装 / 使用 / 安全 / 未验证声明
├── REPORT.md                本文件
├── plugin/                  ← 可安装 bundle（1104 行文本 + 386 行 JS）
│   ├── package.json         dsh.bundle.patch 指向 cordis.patch.yml，零 @deepseek-ai/* 依赖
│   ├── cordis.patch.yml     两行 insert：mcp-client + 本插件
│   ├── index.js             386 行，纯 ESM 零第三方 import
│   ├── skills/
│   │   ├── unreal-mcp/SKILL.md                    152 行 + 2 个 reference（274 行）
│   │   ├── create-toolset/SKILL.md                402 行
│   │   └── unreal-skill/SKILL.md                  143 行
│   ├── locale/{en,zh}.json  meta.title / meta.description
│   ├── icon.svg             自绘（非 Epic 商标）
│   ├── LICENSE-Epic-Games-MIT.txt
│   └── NOTICE.md            121 行，逐文件改动清单
└── tests/                   验证工程（6 个文件）
```

bundle 的两个组件各司其职：

1. **`unreal-mcp-client` 行** —— 复用官方 `@deepseek-ai/dsh-mcp-client`，
   `serverName: unreal`、`streamable-http`、`url` 用 `!!js` 读 `UNREAL_MCP_PORT` 回落 8000、
   `toolCallTimeoutMs: 300000`、`failOnStartupError: false`、`reconnect.maxAttempts: 100000`。
2. **`unreal-mcp` 行** —— 本 bundle 的 Host 插件（`index.js`）：
   - `ctx.skills.registerProvider()` 注册 3 个 bundled skill（从包内 `skills/` 读，不落盘用户目录）；
   - `ctx.inject(['systemPrompt'], ...)` 注册 `unreal-mcp:project` section（order 3105），
     按 session cwd 向上探测 UE 工程，命中才注入一句话——这是 Epic `SessionStart` hook 的 DSH 等价物。

---

## 4. 验证矩阵

### 4.1 自动化验证（`tests/run-all.sh`，126 断言 / 0 失败 / exit 0）

```bash
cd unreal-mcp-dsh/tests && ./run-all.sh
# 断言总计   : 126 passed, 0 failed
# 测试文件   : 3/3 通过，0 跳过
# EXIT       : 0
```

| 测试 | 断言 | 结果 | 覆盖 |
|---|---|---|---|
| `wire-contract.test.mjs` | 38 | **PASS** | 真 DSH SDK × mock：session 头、202 空体、SSE 的 tools/call、3 元工具、GET 404 与 GET SSE 可用**双变体**、两个真实坑、Origin 403 |
| `plugin-unit.test.mjs` | 61 | **PASS** | 真 `plugin/index.js`：manifest、零依赖、3 个 skill candidate、section 字段、**4 种 UE 探测目录**、skills 缺失优雅降级 |
| `integration.test.mjs` | 27 | **PASS** | **真组合无 fallback**：真 cordis + 真 SystemPrompt + 真 ToolRuntime + 真 mcp-client + mock |

integration 的关键输出（原样）：

```
patch config keys = serverName, transport, url, toolCallTimeoutMs, failOnStartupError, reconnect
resolved: serverName=unreal transport=streamable-http url=http://127.0.0.1:8000/mcp
timeout=300000ms attempts=100000 delay0=1000ms
ctx.tools 可见工具 = ["mcp__unreal__list_toolsets","mcp__unreal__describe_toolset","mcp__unreal__call_tool"]
list_toolsets → ["editor_toolset.toolsets.scene.SceneTools", ...]
call_tool → returnValue = {"levelPath":"/Game/Maps/Main.Main","isPersistent":true}
find_actors → 1 个 actor，refPath=/Game/Maps/Main.Main:PersistentLevel.PointLight_0
抛错消息: "Unknown tool"
抛错消息: "input param \"captureTransform\" needs a default value"
慢响应调用耗时 2008ms（mock 延迟 2000ms），timeout=300000ms → 正常返回
对照组在 304ms 处超时失败（预期），错误: Request timed out
连不上时可见工具数 = 0（无 mcp__unreal__*），未抛异常
```

### 4.2 Lead 独立验证（不复用团队测试代码，防止「测自己的假设」）

| 验证项 | 方法 | 结果 |
|---|---|---|
| **bundle 能被真实安装流程接受** | 干净 scratch profile + `dsh plugin add link:...` | ✅ 装成功；**且 `add` 会自动把 bundle 追加进 `dsh.profile.bundles`**，无需手工编辑 profile |
| **组合后的配置树正确** | `dsh --profile X --dump-config \| grep -A6 unreal-mcp` | ✅ 两行（`unreal-mcp-client` + `unreal-mcp`）与全部 config 字段正确出现 |
| **真实 DSH 进程确实连上默认端口 8000** | 起 mock 在 8000，boot 真 profile，读 mock 服务端 JSONL | ✅ 完整握手 5 步（见 §2.1 表） |
| **`UNREAL_MCP_PORT` 环境变量覆盖真的生效** | mock 起在 9123，`UNREAL_MCP_PORT=9123` boot 真 profile | ✅ mock 在 9123 收到完整握手 5 步（未连 8000） |
| **插件从 profile 的 node_modules 加载** | `import` profile 软链下的真实入口 | ✅ 3 skill（rank=600）+ section（order 3105）全部正确 |
| **skill 正文含关键契约** | 直接断言正文内容 | ✅ 含三个 `mcp__unreal__*` 名、`JSON.parse`、`returnValue`、`toolset_name`、`tool_name`；**0 处**把 `.mcp.json` 当必需 |
| **返回值形状与 isError 行为** | 真 Context + 真 mcp-client 跑一次 | ✅ 与 verifier 结论一致（见 §2.3） |
| **UE 探测算法 4 种目录** | 独立实现 + 独立临时目录 | ✅ 含「裸 `Engine/` 不算工程」这个 Epic 明确警告的坑 |
| **打包内容完整** | `npm pack --dry-run` | ✅ 13 个文件全部进包，无遗漏 |

### 4.3 团队组内额外自检（bundle-author 在真 DSH runtime 上补的、verifier 断言之外的）

| 验证项 | 结果 |
|---|---|
| 真 cordis + 真 `SkillRegistry`（非假 ctx）：3 个 skill 注册、`registry.get()` 全部解析、body 剥 frontmatter、dispose 后目录清空 | 26 断言通过 |
| 真 `dsh-system-prompt`：`getSectionOrder('MCP_SERVERS') === 3100`、section 在 `assemble()` 中存在且 `interpolate:false`、`renderPrompt()` 按 cwd 变化重算 | 11 断言通过 |
| `patch` 用 DSH 自己的 `!!js` YAML 方言解析后喂给真 `mcp-client` 的 `Config` schemastery | 47 断言通过 |
| 降级：只 provide `skills` 不给 `systemPrompt`，插件仍激活且 3 skill 照常注册 | 2 断言通过 |

### 4.4 环境清理确认

- `~/.dsh/profiles/` 下**只**删除了我创建的两个 scratch profile（`probe1`、`finaltest`），
  用户的 `desktop` profile 与 `web` profile **未改动**（已比对 `package.json`）。
- 所有 mock 进程已 kill，8000 端口已释放，临时目录已清理。

---

## 5. 未验证 / 边界（如实声明）

> **更新**：真机验证已于 2026-10-20 完成（UE 5.8 + `UE5McpTest` 工程），
> 见 §2.1、§2.3 与 §2.4。下表只保留**仍未**验证的项。

| 项 | 状态 | 原因 |
|---|---|---|
| **toolset 的完整覆盖** | ⚠️ 部分 | 数量随工程变化（实测 67 与 55 两种）；只深入测了 `SceneTools` / `EditorAppToolset` / `AgentSkillToolset` / `ObjectTools`；其余以活着的 `describe_toolset` 为准 |
| game thread 真实阻塞时长（长编译/大资产） | ❌ 未验证 | 只测了毫秒级只读调用与 7.1 MB 截图；未测重编译场景 |
| Windows / Linux 平台 | ❌ 未验证 | 全部真机验证在 macOS arm64 完成 |
| 编辑器 Live Coding 重编是否断 session | ❌ 未验证 | 未触发重编；若报 `no valid session ID provided`，按 §5.1 恢复 |
| 超大结果边界 | ❌ 未验证 | 7.1 MB PNG 正常；更高分辨率序列帧未测 |

### 5.1 已知限制：编辑器重启后需要手动重建连接（**已实测确认**）

这是本次交付中**唯一一个影响日常使用的功能性缺陷**，如实记录。

**现象**：用户关掉 Unreal Editor 再打开后，DSH 里所有 UE 工具调用失败：

```
Error POSTing to endpoint: {"jsonrpc":"2.0","id":2,"error":{"code":-32000,
  "message":"Bad Request: no valid session ID provided"}}
```

**根因（读 SDK 源码 + 对照实验确认）**：

1. MCP 会话绑定在具体的编辑器进程上，`Mcp-Session-Id` 在编辑器重启后作废；
2. 编辑器关闭 → 端口消失；
3. **但客户端收不到断线信号**：
   - `GET /mcp` 返回 404 的引擎 build → SDK 只调 `onerror`，不调 `onclose`；
   - 提供 GET SSE 长连的 build → 流结束/断开时 `_handleSseStream` 要满足
     `isReconnectable || hasPrimingEvent` 且无响应才重连，本场景不满足；
4. `dsh-mcp-client` 的重连完全挂在 `generation.onclose` 上：
   `generation.onclose = () => { ... if (attemptSettled) generationDown(generation) }`；
5. `onclose` 不触发 → 不重连 → 工具仍注册 → 调用打到已死的 session。

**实测证据（两种引擎行为都失败，故不是特例）**：

| 场景 | 关闭编辑器 4s 后重启、等 8~10s 再调用 |
|---|---|
| `GET /mcp` → 404（部分 build） | ❌ `Bad Request: no valid session ID provided` |
| `GET /mcp` → 200 长连 SSE | ❌ 同样失败 |
| **DSH 先启动、编辑器后启动（首连，非重启）** | ✅ 5.7 秒内自动连上，`reconnect` 正常 |

**恢复方式（已实测有效）**：dispose 掉 MCP 客户端插件再重新装载，工具 0 → 3 恢复且调用成功。
用户侧等价操作：Web 侧边栏 **Plugins** → `Unreal Engine MCP` → **关掉再打开**。
秒级，**不需要重启整个 DSH**。

**为什么不在本 bundle 里修**：根因在 `dsh-mcp-client` 的上游生命周期（重连只挂 `onclose`）。
可行 workaround 是加一个监听 `tools/result`、连续失败 N 次就 dispose + 重建 mcp-client 实例的插件，
但那是绕过官方插件生命周期、接管其 fiber 所有权的侵入式做法，有风险。
按用户决定：**接受该限制并在文档中明确说明**（README §7、`operations.md` §D、`SKILL.md` 高频报错表），
同时建议向上游提 issue。

### 5.2 关于「编辑器崩溃/重启」的覆盖变化

该场景原先列在「未验证」里，理由是 mock 覆盖不到。本次实际用「kill mock + 同端口重启」
**完整复现了**该场景，并因此发现 5.1 的缺陷 —— 这一项已从「未验证」转为「已验证（发现缺陷）」。
仍无法验证的是：真实引擎在编译、Live Coding 重编、PIE 切换等情况下是否也会让 session 失效。

### 第一次在真 UE 上跑，按这个顺序确认

1. `mcp__unreal__list_toolsets` 有返回 → **连接通**
2. `mcp__unreal__describe_toolset({toolset_name: <上一步某个全限定名>})` 有 schema → **派发链路通**
3. 挑一个只读工具（`get_current_level`）真调一次 → **game thread 通**

---

## 6. 过程中发现并修正的坑（给后来者）

| 坑 | 结论 | 影响 |
|---|---|---|
| **profile 安装的普通 JS 插件无法 `import '@deepseek-ai/*'`** | DSH 的双锚点解析只覆盖 patch 里的 `name` 字段，不覆盖插件文件内部的 import | `index.js` 必须零第三方 import；`BUNDLED_SKILL_RANK = 600` 内联 |
| `ctx.plugin(ToolRuntime)` 静默不激活 | `ToolRuntime.inject = ['systemPrompt']`，不先装 SystemPrompt 就永远是 inactive | integration 测试必须按 `SystemPrompt → ToolRuntime → mcp-client` 顺序装 |
| headless profile 里延迟取服务会失败 | `ctx.inject` 的回调在 `apply()` 返回后进入 inactive context | 不要在 boot 后的 `setTimeout` 里访问 `ctx.get('tools')` |
| `!!js` 是 DSH 合法的 YAML 方言 | `dsh-app-boot` 的 `entryListSchema = yaml.JSON_SCHEMA.extend(JsExpr)` | 用裸 yaml 工具校验 patch 会误报；测试用真方言 |
| `server/discover` 首次 400 不是故障 | SDK 2.2.0 的 era 探测，HTTP 400 后自动回落 legacy `initialize` | mock 必须像 UE 一样对未知 session 的 POST 回 400 才能复现真实路径 |
| skill summary 不含 `rank` | DSH 的 `toSummary()` 会剥离 rank，只在 registry 内部用于排序 | 断言 rank 要直接测 provider 的 candidate，不能测 list() 的返回 |

### 关于 `maxAttempts: 100000` 的说明

在 `maxDelayMs = 30s` 退避下约等于**无限重试**。这是刻意的（让用户可以先开 DSH 再开编辑器），
但代价是：**长期连不上时不会自愈注销工具，而是持续重试**。使用者若发现工具一直不出现，
应先确认编辑器与端口，而不是等 DSH 放弃。

---

## 7. 安全边界（务必转达给使用者）

| 面 | 事实 |
|---|---|
| 绑定 | 只绑 `127.0.0.1`，拒绝非 loopback `Origin` |
| 认证 | **无认证层**。同机同用户任意进程都能连 |
| 暴露 | Epic 明确「不适合暴露到本机之外」 |
| 破坏性 | 工具直接改 live UObject 状态，可能改/移/删 VCS 跟踪资产 |
| Python 沙箱 | `execute_tool_script` 是受限沙箱（白名单 6 模块、无 `unreal`、无 eval、只读 `open`） |

**红线**：别在共享机器开这个 server；批量资产操作前后各 commit 一次。

---

## 8. 复用与许可

- `skills/` 下的三个 skill 派生自 **Epic Games** 的 MIT 许可插件
  `EpicGames/unreal-engine-skills-for-claude-code-plugin` @ `a6aa73a`。
  原始 MIT 文本见 `plugin/LICENSE-Epic-Games-MIT.txt`，逐文件改动清单见 `plugin/NOTICE.md`（121 行）。
- 引擎侧 `ModelContextProtocol` 插件归 Epic，闭源、随引擎分发，**本包不含其任何代码**。
- 本 bundle 的 `index.js` 与全部 `tests/` 为原创。
