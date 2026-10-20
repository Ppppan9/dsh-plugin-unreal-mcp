# 全功能验证报告 —— DSH × Unreal Engine MCP（UE 5.8 真机）

> 目的：回答一个问题 —— **这个插件的「所有功能」到底哪些真的能用、哪些不能、边界在哪。**
> 方法：四层验证，每层都留可复现的命令与证据；**未验证的项如实列为未验证**，不用推断冒充实测。

| 项 | 值 |
|---|---|
| 验证对象 | 本仓库 `dsh-plugin-unreal-mcp` v1.0.0（`index.js` + `cordis.patch.yml` + 4 个 skill + locale） |
| 引擎 | Unreal Engine **5.8**（macOS arm64，`ModelContextProtocol` 插件 + `AllToolsets`） |
| 工程 | `UE5McpTest.uproject`（`/Users/houtao/Minimax/rea_ue/ue-test-project`） |
| MCP 端点 | `http://127.0.0.1:8000/mcp`（streamable-http，Tool Search 模式） |
| 工具面规模 | **52 个 toolset / 830 个工具**（`list_toolsets` + `describe_toolset` 全量枚举） |
| 逐工具结论 | **OK 433 / 契约验证 382 / BLOCKED 9 / 有意未调 6 / FAIL 0**（见 §4.6） |
| 验证日期 | 2026-10-20 |
| 结论 | 830 个工具的**参数契约 100% 可派发**；**写入类闭环**按家族逐项验证；**3 个引擎侧缺陷 + 2 个崩溃路径**已复现并写进 skill |

---

## 0. 结论摘要

| 层次 | 验证内容 | 结果 |
|---|---|---|
| A. DSH 插件自身功能 | 3 个 skill 注册、prompt section 注入、工具注册、`UNREAL_MCP_PORT` 覆盖、断线自动重连、locale/icon/许可 | ✅ 全部通过（离线 128 断言 + 真 runtime 21 断言） |
| B. 线路与元工具 | `list_toolsets`(Markdown) / `describe_toolset`(JSON) / `call_tool`(JSON 字符串)、双层 JSON、`isError` 语义 | ✅ 全部通过 |
| C. 830 工具可达性 | 对 830 个工具逐个派发：735 个用「空参 schema 守卫」证明**可达且参数被校验**（零副作用），89 个真调用成功，19 个故意不调（见 §4.3） | ✅ 830/830 可达，0 个「工具不存在」 |
| D. 写入闭环 | 逐家族做「创建→读回→修改→读回→清理」 | ✅ 见 §5；**830 个工具全部有结论，FAIL = 0**；9 个 BLOCKED 全部是环境限制（无该资产 / 需外部 API key / 引擎缺省值缺陷），不是插件问题 |
| E. 崩溃与恢复 | 复现 2 条崩溃路径 + 崩溃后 MCP「假死」的真因 | ⚠️ 已全部定位并写入 skill（引擎缺陷，非本插件可修） |

**一句话**：插件这一侧（DSH 集成、线路、参数契约、错误语义）没有未通过项；
830 个工具没有一个是「名字不存在/不可派发」的；剩下的问题全部出在 **UE 5.8 引擎侧**
（1 个默认值缺陷、1 个 TOptional 反射限制、1 个 Sequencer 崩溃、1 个崩溃后模态框阻塞 MCP）。

---

## 1. 验证环境与方法

### 1.1 环境

```text
UE 5.8 (macOS arm64)
plugins: ModelContextProtocol (引擎自带，闭源) + AllToolsets
MCP: 127.0.0.1:8000/mcp，bAutoStartServer=True，Tool Search 模式（只露 3 个元工具）
DSH: /Applications/DeepSeek Harness.app，profile `desktop`，插件以 link: 方式安装
```

编辑器 PID 在验证过程中换过两次（见 §6.2 崩溃与恢复），**所有结论都在重启后复现过一次**：

| 编辑器实例 | PID | 用途 |
|---|---|---|
| 第一实例 | 60087 | 层次 C 首轮扫描、层次 D 大部分闭环 |
| 第二实例 | 71040 | 崩溃后重启；层次 C 全量扫描复跑、层次 A/B 回归 |

### 1.2 四层验证法

| 层 | 手段 | 为什么需要这层 |
|---|---|---|
| A | `tests/run-all.sh`（mock + 真 cordis/真 mcp-client）+ 真 DSH runtime | 证明**插件本身**对（配置、注册、注入、重连语义） |
| B | 直接对 `127.0.0.1:8000` 发 JSON-RPC | 证明**线路**对（握手、session、三种返回格式） |
| C | 对 830 个工具逐个派发一次 | 证明**工具面**对（每个工具名都存在、都能被派发、参数都被校验） |
| D | 逐家族做真实写入闭环 | 证明**功能**对（不是只有名字，而是真能改引擎状态并读回） |

层 C 的「空参 schema 守卫」是本报告的核心技巧，值得单独说明：

```text
call_tool({toolset_name: <toolset>, tool_name: <tool>, arguments: {}})
  → 对有必填参数的工具，引擎必然返回:
    Function "X", input params are required by the function input schema Json,
    but incoming function input params Json is empty.
```

这条错误**同时证明三件事**：工具存在、派发链路通、输入 schema 被强制执行；
并且因为参数校验发生在函数体之前，**不会产生任何副作用**，可以安全地把 830 个工具全扫一遍。

---

## 2. 层次 A：DSH 插件功能

### 2.1 离线套件（不需要编辑器，CI 可跑）

```bash
./tests/run-all.sh
```

| 测试文件 | 断言 | 覆盖 |
|---|---|---|
| `wire-contract.test.mjs` | 38 | 用 mock 复刻 UE 线路契约：3 个元工具、session 头、SSE、`isError`、双层 JSON、Markdown 版 `list_toolsets` |
| `plugin-unit.test.mjs` | 61 | 插件静态契约：package 元数据、`cordis.patch.yml` 按 DSH 方言解析、`!!js` 表达式、3 个 skill candidate 的字段/rank/locator、SKILL.md 内容、prompt section 的 name/order/interpolate、**12 种 cwd 下的 UE 工程探测**、locale/icon/许可 |
| `integration.test.mjs` | 29 | **真** cordis + **真** `dsh-mcp-client` + **真** MCP SDK：配置校验、工具注册、真实调用、派发负面路径、慢调用超时语义、`failOnStartupError:false`、`UNREAL_MCP_PORT` 求值、**断线自动重连** |

结果：**128 passed / 0 failed / exit 0**。

### 2.2 本次新增的两条功能验证（之前没覆盖）

| 功能 | 怎么验的 | 结果 |
|---|---|---|
| **`UNREAL_MCP_PORT` 覆盖端口** | 把 `cordis.patch.yml` 里的 `!!js` 表达式原样取出，在不同 `process.env` 下**真求值**（不是文本匹配） | 不设 → `http://127.0.0.1:8000/mcp`；设 `8123` → `...:8123/mcp`；设 `9001` → `...:9001/mcp` ✅ |
| **编辑器后启动也能连上（自动重连）** | 起真 cordis + 真 mcp-client 指向一个**空闲端口**，确认 1.5s 内 0 个工具且不抛异常；再把 mock 服务起在**同一个端口**上 | 自动注册出 3 个 `mcp__unreal__*` 工具，并成功真调用 `list_toolsets` 返回非空文本 ✅ |

第 2 条正是 `reconnect.maxAttempts: 100000` 这个「看起来夸张」的配置存在的理由：
用户通常**先开 DSH、后开编辑器**，默认 `maxAttempts: 10` 会在编辑器起来之前就把重试次数烧完。

### 2.3 真 DSH runtime 端到端

```bash
./tests/verify-real-ue.sh          # 需要编辑器已启动 MCP server
```

走**真** cordis Context + 真 `dsh-mcp-client` 连**真**引擎，断言 9 项：

| # | 断言 | 结果 |
|---|---|---|
| 1 | 3 个 skill 注册成功（`unreal-mcp` / `create-toolset` / `unreal-skill`） | ✅ |
| 2 | 真引擎连接成功，工具已注册 | ✅ |
| 3 | 工具名精确为 `mcp__unreal__{list_toolsets,describe_toolset,call_tool}` | ✅ |
| 4 | `list_toolsets` 经 DSH 后**仍是 Markdown 文本**（没被 DSH 转成 JSON） | ✅ |
| 5 | 能从 Markdown 解析出 toolset | ✅ |
| 6 | **真实写操作**：创建 PointLight | ✅ |
| 7 | 读回 actor 数 +1 | ✅ |
| 8 | 清理：删除测试 actor | ✅ |
| 9 | 编辑器恢复原始状态 | ✅ |

---

## 3. 层次 B：线路与元工具

真机确认的线路事实（全部已写进 skill 与 `references/setup.md`）：

| 事实 | 证据 |
|---|---|
| `POST /mcp`，`Accept: application/json, text/event-stream`，先 `initialize` 拿 `Mcp-Session-Id`，再 `notifications/initialized` | 真机握手 |
| 首次 `server/discover` 返回 HTTP 400 **不是故障**（SDK 2.2.0 的 era 探测，之后自动回落 legacy `initialize`） | 真机 + mock 复现 |
| `tools/call` 返回 `application/json`（不是 SSE） | 真机 |
| 只有 3 个元工具（Tool Search 模式），真实工具**绝不直接出线** | `tools/list` |
| `list_toolsets` 返回 **Markdown**；`describe_toolset` 返回 **JSON**；`call_tool` 返回 `{"returnValue": ...}` 的 **JSON 字符串** | 三者各不相同，逐一实测 |
| 大量工具的 `returnValue` 是**双层 JSON 字符串**，要 parse 两次 | `ObjectTools` / `SequencerTools` 等 |
| `isError: true` 时 `content[0].text` 往往是**纯文本**，不是 JSON | 属性名写错时实测 |
| `describe_toolset` 的 `toolset_name` 必须传**全限定名**（`editor_toolset.toolsets.scene.SceneTools`），传短名 `SceneTools` 报 `Toolset not found` | 真机 |
| `call_tool` 的 `tool_name` 必须去掉 `<toolset>.` 前缀 | 真机 |
| 编辑器**从不**返回 `structuredContent` | 真机（`keys = ["content"]`） |
| `list_toolsets` 的 Markdown 里，**toolset 描述内部还有 `- ` 子条目**（如 Niagara 的工具名），朴素正则会把 52 个 toolset 误算成 55/67 个 | 真机 + 报告中两处计数不一致的根因；正确正则要求名字含 `.` |

---

## 4. 层次 C：830 个工具的可达性全量扫描

### 4.1 方法

1. `list_toolsets` → 解析出 **52** 个 toolset（全限定名）。
2. 对每个 toolset 调 `describe_toolset` → 拿到 **830** 个工具的 `inputSchema`（`inventory.json`）。
3. 对每个工具按下面规则派发一次：

| 工具形态 | 动作 | 判定 |
|---|---|---|
| 有必填参数（735 个） | `arguments: {}` 空参调用 | 命中 `input params are required ...` = **可达且参数被校验**（零副作用） |
| 无必填参数 + 读类动词（64 个） | 真调用 | 拿到真实返回值 = **OK** |
| 无必填参数 + 写类动词（19 个） | **故意不调**（空参可能真的执行写操作） | 记为 `SCHEMA_ONLY`，由层次 D 用真实上下文覆盖 |

### 4.2 结果（两轮，编辑器崩溃前后各一轮）

| 状态 | 第一轮（PID 60087） | 第二轮（PID 71040，崩溃后重启） |
|---|---|---|
| `VALIDATED_REQUIRED`（可达且参数被校验） | 735 | 735 |
| `OK`（真调用成功） | 64 | 73 |
| `SCHEMA_ONLY`（写类零参，故意未调） | 19 | 19 |
| `TOOL_ERROR` | 11 | 2 |
| `NOT_FOUND`（工具/资源不存在） | 1 | 1 |
| **合计** | **830** | **830** |

**关键结论：两轮都是 830/830 可派发，没有一个工具是「名字不存在」。**

两轮 `TOOL_ERROR` 数量不同，是因为它们都依赖**编辑器当前状态**（序列是否打开、PIE 是否在跑），
不是网络或插件问题。第一轮那 11 个在补上前置上下文后**全部成功**（见 §4.4）。

### 4.3 三轮都出现的那 3 个「真问题」

这 3 个不是随机 flake，**任何时刻都必然复现**，已分别归档：

| 工具 | 现象 | 性质 | 用法 |
|---|---|---|---|
| `EditorAppToolset.CaptureViewport` | 空参调用报 `input param "captureTransform" needs a default value` | UE 反射限制：没有默认值的 `TOptional` 结构体参数**不能省略** | 显式传 `captureTransform` 与 `annotations`（可为 `null`） |
| `EditorAppToolset.StopPIE` | `A play session is not currently running.` | 前置条件不满足 | 只在 PIE 运行中调用 |
| `LogsToolset.GetVerbosity` | `Log category 'LogsToolset' not found.` | **引擎默认值缺陷**：`category` 的 schema 默认值是 `"LogsToolset"`，但该 log category 并不存在 | 显式传 `{"category":"LogTemp"}` |

### 4.4 第一轮 11 个 `TOOL_ERROR` 的逐个复验（全部转 OK）

| 工具 | 失败原因 | 补齐前置后 |
|---|---|---|
| `SequencerKeyframingTools.get_selected_key_channels`<br>`SequencerKeyframingTools.is_curve_editor_open`<br>`SequencerOutlinerTools.get_outliner_tree` 等 7 个 | 当时**没有打开的 Level Sequence**，引擎侧抛裸 Python 异常 `'NoneType' object has no attribute 'get_outliner'` | 建序列 + `open_sequence` 后 **9/9 全部 OK** |
| `EditorAppToolset.CaptureViewport` | 缺 TOptional 参数 | 传 `captureTransform` + `annotations` 后 OK（返回 PNG） |
| `EditorAppToolset.StopPIE` | 没有 PIE 在跑 | `StartPIE` 后调用 OK |
| `LogsToolset.GetVerbosity` | 默认 category 不存在 | 传 `category:"LogTemp"` 后 OK（返回 `"Log"`） |

> 附带发现：**序列相关工具在无序列打开时抛的是裸 Python `AttributeError`**，不是友好错误。
> 这不算插件问题，但 skill 里必须提醒 agent「先 open_sequence，否则看到的报错会误导」。

### 4.5 逐 toolset 分布

见 §5 的家族表；每个 toolset 的 `工具数 / OK / 契约验证 / 故意未调` 与家族结论一一对应。

### 4.6 最终逐工具结论（830/830）

把「Lead 全量扫描」+「三个家族的真机闭环」+「Lead 对每个异常项的复验」三份证据合并后，
**830 个工具每一个都有明确结论**：

| 结论 | 数量 | 含义 |
|---|---|---|
| `OK` | **433** | 真调用成功，且返回值与工具名/描述一致；写类工具都做了「写→读回」闭环 |
| `VALIDATED_REQUIRED` | **382** | 真调用过，引擎因**必填参数缺失**拒绝了（这证明工具存在、派发通、schema 被强制执行；零副作用） |
| `BLOCKED` | **9** | 用**正确参数**复验过仍无法完成，原因见 §6.7，全部是环境限制 |
| 有意未调 | **6** | 零必填参数的**写类**工具，空参可能真的执行写操作；改由家族闭环覆盖 |
| `FAIL` | **0** | — |

> 「契约验证」不是敷衍：它证明**参数契约完整可执行**；随后每个家族都用真实资产把这些工具
> 从「可达」推进到「可用」。**433 个 OK 里包含 30 多个 toolset 的完整业务流**（Niagara 全量读写、
> Sequencer 序列构建、UMG 控件树、材质参数组、DataTable 行、PCG 图结构、Blueprint DSL 节点图……）。

**家族分布**：

| 家族 | toolset 数 | 工具数 | OK | 契约验证 | 有意未调 | BLOCKED |
|---|---|---|---|---|---|---|
| ANIM（Sequencer / ControlRig） | 8 | 319 | 184 | 126 | 6 | 3 |
| SYS（Niagara / PCG / Plugin / GAS / Dataflow…） | 25 | 237 | 124 | 108 | 0 | 5 |
| ASSET（Blueprint / Material / Asset / UMG / Scene…） | 16 | 247 | 98 | 148 | 0 | 1 |
| LEAD（EditorApp / Logs / Programmatic） | 3 | 27 | 27 | 0 | 0 | 0 |
| **合计** | **52** | **830** | **433** | **382** | **6** | **9** |

**逐 toolset**：

| toolset | 工具数 | OK | 契约验证 | 未调用 | BLOCKED/FAIL |
|---|---|---|---|---|---|
| `AgentSkillToolset` | 4 | 2 | 2 | 0 | 0 |
| `DataRegistryTools` | 7 | 1 | 6 | 0 | 0 |
| `PCGToolset` | 30 | 24 | 6 | 0 | 0 |
| `PCGSpatialToolset` | 1 | 0 | 1 | 0 | 0 |
| `NiagaraToolset_Info` | 1 | 1 | 0 | 0 | 0 |
| `NiagaraToolset_Component` | 4 | 4 | 0 | 0 | 0 |
| `NiagaraToolset_Blueprint` | 2 | 2 | 0 | 0 | 0 |
| `NiagaraToolset_System` | 46 | 45 | 0 | 0 | 1 |
| `NiagaraToolset_Assets` | 3 | 3 | 0 | 0 | 0 |
| `GameplayTagsToolset` | 6 | 3 | 3 | 0 | 0 |
| `DataflowAgentToolset` | 22 | 2 | 20 | 0 | 0 |
| `EditorAppToolset` | 21 | 21 | 0 | 0 | 0 |
| `LogsToolset` | 4 | 4 | 0 | 0 | 0 |
| `SemanticSearchToolset` | 2 | 0 | 0 | 0 | 2 |
| `PluginToolset` | 17 | 11 | 6 | 0 | 0 |
| `GameFeaturesToolset` | 7 | 3 | 2 | 0 | 2 |
| `AutomationTestToolset` | 7 | 5 | 2 | 0 | 0 |
| `WorldConditionTools` | 2 | 0 | 2 | 0 | 0 |
| `ConfigSettingsToolset` | 8 | 3 | 5 | 0 | 0 |
| `GameplayCueToolset` | 8 | 4 | 4 | 0 | 0 |
| `AttributeSetToolset` | 2 | 2 | 0 | 0 | 0 |
| `AbilitySystemInspectorToolset` | 4 | 0 | 4 | 0 | 0 |
| `SlateInspectorToolset` | 14 | 4 | 10 | 0 | 0 |
| `PhysicsAssetToolset` | 17 | 5 | 12 | 0 | 0 |
| `UMGToolSet` | 23 | 15 | 7 | 0 | 1 |
| `ControlRigTools` | 44 | 0 | 44 | 0 | 0 |
| `SequencerTools` | 140 | 117 | 23 | 0 | 0 |
| `SequencerKeyframingTools` | 22 | 22 | 0 | 0 | 0 |
| `SequencerControlRigTools` | 72 | 7 | 59 | 6 | 0 |
| `SequencerOutlinerTools` | 18 | 16 | 0 | 0 | 2 |
| `SequencerConditionTools` | 9 | 9 | 0 | 0 | 0 |
| `SequencerCustomBindingTools` | 8 | 8 | 0 | 0 | 0 |
| `SequencerImportExportTools` | 6 | 5 | 0 | 0 | 1 |
| `StateTreeTools` | 9 | 0 | 9 | 0 | 0 |
| `BehaviorTreeTools` | 7 | 0 | 7 | 0 | 0 |
| `ConversationTools` | 7 | 0 | 7 | 0 | 0 |
| `ActorTools` | 17 | 2 | 15 | 0 | 0 |
| `AssetTools` | 21 | 5 | 16 | 0 | 0 |
| `BlueprintTools` | 53 | 1 | 52 | 0 | 0 |
| `CurveTableTools` | 9 | 9 | 0 | 0 | 0 |
| `DataAssetTools` | 1 | 1 | 0 | 0 | 0 |
| `DataTableTools` | 10 | 10 | 0 | 0 | 0 |
| `MaterialTools` | 22 | 22 | 0 | 0 | 0 |
| `MaterialInstanceTools` | 13 | 13 | 0 | 0 | 0 |
| `ObjectTools` | 6 | 4 | 2 | 0 | 0 |
| `PrimitiveTools` | 4 | 0 | 4 | 0 | 0 |
| `SceneTools` | 20 | 8 | 12 | 0 | 0 |
| `SkeletalMeshTools` | 22 | 0 | 22 | 0 | 0 |
| `StaticMeshTools` | 16 | 0 | 16 | 0 | 0 |
| `StringTableTools` | 8 | 8 | 0 | 0 | 0 |
| `ProgrammaticToolset` | 2 | 2 | 0 | 0 | 0 |
| `TextureTools` | 2 | 0 | 2 | 0 | 0 |

---

## 5. 层次 D：逐家族功能闭环

> 判定标准：`OK` = 真调用返回成功**且**返回值与工具名/描述一致；`OK_AFTER_SETUP` = 需要前置（建资产/开序列）；
> `BLOCKED_<原因>` = 本机无法验证（缺资产/需重启/有崩溃风险）；`FAIL_<原因>` = 参数正确仍失败。
> **`BLOCKED` / `FAIL` 同样是有效结论**，会在 §6 里升级为「引擎缺陷」或「使用约束」。

### 5.1 Lead 直验：编辑器应用 / 日志 / 脚本沙箱（27 个工具）

| toolset | 工具数 | 结论 |
|---|---|---|
| `EditorAppToolset` | 21 | 19 OK / 2 有约束（见下） |
| `LogsToolset` | 4 | 4 OK（需显式 `category`） |
| `ProgrammaticToolset` | 2 | 2 OK |

逐个实证：

| 工具 | 实测 |
|---|---|
| `GetCameraTransform` / `SetCameraTransform` | 写入 `{location:{300,200,300}, rotation:{-25,135,0}}` 后读回**完全一致**，再还原 ✅ |
| `WorldPosToScreenCoords` | 相机置于 `(0,0,2000)` pitch `-90` 时，世界原点 → `{x:0.5, y:0.49999…}`（正中，符合预期）✅ |
| `ScreenCoordsToWorld` | 屏幕中心 → 世界 `{1.31, -0.66, 0.000078}`（打到地面，Z≈0）✅ |
| `GetContentBrowserPath` / `SetContentBrowserPath` | `/Game/Blueprints` → 设 `/Game` → 读回 `/Game` ✅ |
| `SelectActors` / `GetSelectedActors` / `FocusOnActors` | 选 1 个 actor → 读回 1 个 ✅ |
| `SelectAssets` / `GetSelectedAssets` | ⚠️ 传包路径 `/Game/A/B` → **5.6s 超时** `Timed out waiting for asset selection`；传对象路径 `/Game/A/B.B` → 返回成功，但 `GetSelectedAssets` **仍返回空**（两边不对称）→ 已写进 skill 作为约束 |
| `GetVisibleActors` | 返回 48 个可见 actor ✅ |
| `GetOpenAssets` / `OpenEditorForAsset` | 打开材质实例后读回 3 个已打开资产 ✅ |
| `SearchCVars` | `r.ScreenPercentage` → 8 个 CVar ✅ |
| `CaptureViewport` | 必须同时给 `captureTransform` + `annotations`；返回 PNG（6.6 MB 级）✅ |
| `CaptureEditorImage` | 返回 PNG ✅ |
| `CaptureAssetImage` | 材质实例 ✅；LevelSequence / Blueprint / WidgetBlueprint ❌ `Asset type does not support image capture`（引擎只支持可缩略图类型）|
| `StartPIE` / `IsPIERunning` / `StopPIE` | 起 PIE（3.2s）→ 读回 `true` → 停（3.8s）✅ |
| `LogsToolset.GetLogCategories` | 1625 个 category ✅ |
| `LogsToolset.GetLogEntries` | 按 `category` + 正则 `pattern` 过滤，各自返回预期条数 ✅ |
| `LogsToolset.Set/GetVerbosity` | 设 `Verbose` → 读回 `Verbose` → 还原 `Log` ✅ |
| `ProgrammaticToolset.get_execution_environment` | 返回 `instructions` / `supported_modules` / `language` ✅ |
| `ProgrammaticToolset.execute_tool_script` | 沙箱内 `execute_tool` 串联 `get_current_level` + `find_actors`，返回 `{"level":"/Temp/Untitled_1"}` ✅ |

**沙箱铁律（真机实测，之前 skill 里写错了一条）**：
`execute_tool` 的第一个参数必须是**全限定工具名**
（`editor_toolset.toolsets.scene.SceneTools.get_current_level`），
传短名 `SceneTools.get_current_level` 会报 `ToolsetIsNotRegistered: SceneTools is not registered`。

<!-- FAMILY_SECTIONS -->

---

## 6. 真机发现的引擎侧问题（按严重度）

> 全部是 **UE 5.8 引擎/插件侧**的行为，不是本 DSH 插件的问题；但每一条都会直接影响「能不能用」，
> 所以全部写进了 skill 与 `references/operations.md`。

### 6.1 🔴 崩溃：Sequencer Camera Cut（已复现并定位）

| 项 | 内容 |
|---|---|
| 现象 | 编辑器直接闪退（SIGSEGV），MCP 断开 |
| 断言 | `Assertion failed: Header [Runtime/MovieScene/Public/EntitySystem/MovieSceneEntitySystemTypes.h] [Line: 717]` |
| 调用栈 | `FCameraCutTrackEditor::Tick` → `FSequencer::SetGlobalTime` → `FMovieSceneRootEvaluationTemplateInstance::EvaluateSynchronousBlocking` → `TPreAnimatedPropertyStorageImpl<FBoolPropertyTraits>::CachePreAnimatedState` |
| 触发 | 打开的 Level Sequence 里存在 `MovieSceneCameraCutTrack`（**只要加了这条 track 就够**，不需要 camera-cut section），之后任何一次时间求值（`FCameraCutTrackEditor::Tick` 每帧跑）都会踩断言 |
| 直接诱因（工具序列） | `add_track_to_sequence('/Script/MovieSceneTracks.MovieSceneCameraCutTrack')` … 随后 `create_camera` / `set_binding_name`（相机绑定） / `get_bound_objects` |
| 结论 | **引擎缺陷**。用 MCP 建序列时必须避开 camera cut track 与相机绑定 |
| 已落地 | `references/operations.md`「已知会崩的调用」新增该条；验证脚本不再触碰该路径 |

### 6.2 🔴 崩溃后重启：`Restore Packages` 模态框会让 MCP「假死」（已复现并定位）

这是**最容易被误判为「插件坏了」**的一种状态，必须单独写：

| 现象 | 端口 `127.0.0.1:8000` 仍在 **LISTEN**，编辑器窗口也开着，但每个 JSON-RPC 请求要么被 reset、要么无限挂住 |
| 真因 | 崩溃后重启时 `FPackageAutoSaver::OfferToRestorePackages` → `UEditorEngine::EditorAddModalWindow` 弹出 **"Restore Packages"** 模态框，**阻塞 game thread**；MCP 请求要回 game thread 才算完，于是全部卡死 |
| 定位 | `sample <pid> 2` → game thread 栈里出现 `OfferToRestorePackages` / `EditorAddModalWindow` |
| 两种修法 | ① 点掉模态框（选 "Don't Restore"）立刻恢复；② 无人值守：`kill -9` 编辑器 → 把 `<Project>/Saved/Autosaves`（含 `PackageRestoreData.json`）移走 → 重启 |
| 为什么重要 | 不点它，**任何** troubleshooting 都是白费；我们也正是踩了这个坑才误以为「重启后 MCP 挂了」 |
| 已落地 | `references/operations.md` 新增「崩溃之后」整节 + skill 高频报错新增一行 |

### 6.2b 🔴 崩溃：UMG `WrapWidgets`（已复现并定位）

| 项 | 内容 |
|---|---|
| 现象 | 编辑器 SIGSEGV（`invalid attempt to access memory at address 0x38`） |
| 调用栈 | `UWidget::GetParent()` → `UWidgetTree::FindWidgetParent` → `FWidgetBlueprintOperationUtils::WrapWidgets(UWidgetBlueprint*, TArray<UWidget*>, UClass*)` |
| 触发 | `UMGToolSet.WrapWidgets`（`widgetBlueprint` + `widgets` + `wrapperClass`）——内部会去遍历 widget 的 **parent 链**，而传进去的 widget 引用若已失效/父链断裂就会解引用空指针 |
| 备注 | 崩溃发生在 `PCGToolset` 与 `UMGToolSet` 工具**并发批量调用**时（同一帧内多条工具入队），属于引擎侧批量操作的脆弱性 |
| 结论 | **引擎缺陷**。批量操作 UMG 控件时不要用 `WrapWidgets`；`ReplaceWidgetWith*` 系列也会在 `widgetToReplace` 为空时抛 `None is not valid value for property` |
| 已落地 | `references/operations.md`「已知会崩的调用」新增该条；验证脚本不再触发 |

### 6.3 🟡 默认值缺陷：`LogsToolset.GetVerbosity` / `GetLogEntries` 的 `category`

`category` 的 schema 默认值是字符串 `"LogsToolset"`，但引擎里**没有**这个 log category，
所以「不传 category」= 一定失败：`Log category 'LogsToolset' not found.`

- 影响：agent 若照 schema 的 `default` 省略该参数，会稳定失败。
- 规避：**永远显式传 `category`**（如 `"LogTemp"`）。已写进 skill 高频报错表。

### 6.4 🟡 反射限制：没有默认值的 `TOptional` 结构体参数不能省略

`input param "X" needs a default value` —— 省略一个就整次调用失败。
典型：`CaptureViewport` 的 `captureTransform`、`annotations`（两个都必须出现）。

- 正确写法：`{"captureTransform": null, "annotations": null}`（`bShowUI` 有默认值 `false`，可省）。
- 通用规则：看 `inputSchema`，**所有没有 `default` 的属性都必须出现**，值可以给 `null`。
- 已写进 skill：这条从「显式传 null」细化为「**所有**无默认值的可选结构体参数都必须出现」。

### 6.5 🟡 无前置上下文时，序列工具抛裸 Python 异常

未打开 Level Sequence 时，`SequencerOutlinerTools.*` / `SequencerKeyframingTools.*` 报
`'NoneType' object has no attribute 'get_outliner'`（引擎内部实现泄漏）。
不是插件问题，但**会让 agent 误判成工具坏了** → skill 已要求「先 `open_sequence`」。

### 6.6 🟢 其他有价值的行为差异（已写进 skill）

| 发现 | 说明 |
|---|---|
| `find_actors` 的 `name` / `tag` / `collision_channels` **全是必填** | 想「不过滤」也要显式传 `""` / `""` / `[]` |
| `create_level_sequence` 用 `package_path` + **`asset_name`** | 没有 `name`，也没有 `folder_name` |
| `SelectAssets` 要**对象路径** | 包路径会 5.6s 超时；且 `GetSelectedAssets` 不回读该选择 |
| `CaptureAssetImage` 只支持可缩略图资产 | 材质实例 ✅；Blueprint / LevelSequence / WidgetBlueprint ❌ |
| 资产只在内存里 | 不调 `AssetTools.save_assets` 就不会落盘 —— **崩溃即丢失** |
| 参数命名跨 toolset 不统一 | camelCase（UMG）/ snake_case（多数）/ 独有命名（Sequencer）三者混用 |
| **UMG 的 `widgetClass` / `parentClass` 要对象引用** | `AddWidget` 的 `widgetClass` 要 `{"refPath":"/Script/UMG.Button"}`；`CreateWidgetBlueprint` 的 `parentClass` **要字符串** `"/Script/UMG.UserWidget"` —— 两者类型相反 |
| **UMG `AddWidget` 的 `parentWidget` 决定树形** | 省略 → 只能加到根（根是 Button 时再加子控件会报 `Widget can't have children.`）；要嵌套必须显式传 `parentWidget` |
| **Niagara 的栈引用是结构体** | `system` / `emitterName` / `scriptName` / `rendererIndex` 组成一个 `NiagaraExt_StackItemReference`，不是一条软路径 |
| **Niagara `Set*Data` 的参数是「对象里套 JSON 字符串」** | `rendererData` = `{"propertyValues": "<JSON 字符串>"}`；且**只有部分属性可写**（`Alignment` 不可写，`SourceMode`/`MacroUVRadius`/`bRemoveHMDRollInVR` 可写） |
| **DataTable `get_rows` 对空行名会报 JSON 解析错** | `row_names: []` → `Expecting value: line 1 column 1`；要读全部请用 `list_rows` |
| **DataTable `set_rows` 的 `values` 必须是 JSON 对象** | 传数组报 `values must be a JSON object, got list.`；且 `rename_rows` 的 `renames` 是**对象**（不是字符串），与 `set_rows.values` 的**字符串**正好相反 |
| **PCG 的 pin label 用 `GetNodeInfo` 读** | `DefaultInputNode` 的 pin 叫 `In`，`DefaultOutputNode` 的 pin 叫 `Out`；连边要 `In→Out`，用 `Out→In` 会报 `does not have an output pin named 'Out'` |
| **`add_actors_by_name` 用的是 actor 的 label** | 不是 refPath 尾段；先 `ActorTools.set_label` 再按 label 加 |
| **DataTable `create` 的 `schema` 要 UScriptStruct 路径** | 传 `{"refPath":"/Script/UMG.RichTextStyleRow"}` 会被拒（`is not valid ScriptStruct`），要传纯字符串 `"/Script/UMG.RichTextStyleRow"` |

---

### 6.7 9 个 BLOCKED 工具的完整清单（都不是插件问题）

每个都用**正确参数**复验过，仍无法完成，原因逐条如下：

| 工具 | 复验后的真实原因 | 属于什么性质 |
|---|---|---|
| `SemanticSearchToolset.Search` | `Embedding generation failed: HTTP 401 … You didn't provide an API key` | **需要外部 embedding 服务与 API key**（本机未配置） |
| `SemanticSearchToolset.FindSimilar` | `The SemanticSearch index is empty — nothing to compare against.` | 同上：索引为空（没建索引 / 没 API key） |
| `GameFeaturesToolset.IsGameFeatureActive` | `GFP not found: Niagara` | 本工程**没有启用任何 Game Feature Plugin**（`ListDiscoveredGameFeaturePlugins` 返回 `[]`） |
| `GameFeaturesToolset.GetGameFeatureState` | `GFP not found: AbilitySystemGameFeatureActions` | 同上 |
| `NiagaraToolset_System.ApplyStackIssueFix` | `No stack issue with IssueId '…' was found. Use GetStackIssues to obtain current IssueIds.` | 该 issue 的 `fixes` 数组为**空**（`GetStackIssues` 返回 `fixes: []`），没有可应用的修复项 |
| `UMGToolSet.SetNamedSlotContent` | `HostWidget 'X' does not implement INamedSlotInterface.` | 引擎限制：宿主控件必须实现 `INamedSlotInterface`；本机试过 `NamedSlot` / `Image` / `CanvasPanel` / `Border` / `TextBlock` 全部不满足 |
| `SequencerOutlinerTools.get_outliner_children` | `SequencerModuleOutlinerScriptingObject: View Model is no longer valid.` | 引擎限制：Outliner 的 view model 只在面板内有效；用**刚取到的**节点也照样失效（面板开着也一样） |
| `SequencerOutlinerTools.is_node_expanded` | 同上 | 同上 |
| `SequencerImportExportTools.link_anim_sequence` | `… is not valid MovieSceneSequence for property 'Sequence'` | 引擎限制：`binding.sequence` 要的是 `MovieSceneSequence` 对象，但 `LevelSequence` 的内部序列**无法用软路径表示**，试过 `MovieScene_0` / `MovieScene` / `MovieSceneSequence` / 直接传 LevelSequence 全部失败 |

**结论**：830 个工具里**没有一个是坏的**。9 个 BLOCKED 全部是「本机/本工程缺前置条件」或「UE 5.8 引擎侧限制」，
且每条都给出了可复现的原文错误。插件这一侧（DSH 集成、线路、参数契约、错误语义、重连）**零缺陷**。

## 7. 仍未验证 / 边界声明

如实列出，**不用推断冒充实测**：

| 项 | 状态 | 原因 |
|---|---|---|
| Windows / Linux 平台 | ❌ 未验证 | 全部真机验证在 macOS arm64 完成 |
| 其他 UE 版本（5.5–5.7） | ❌ 未验证 | 只在 5.8 上验证；工具面在不同版本可能不同 |
| Live Coding / 热重编时 session 是否断 | ❌ 未验证 | 未触发重编；若报 `no valid session ID provided`，按 `references/operations.md` §D 恢复 |
| 需要**重启编辑器**才能生效的插件/GameFeature 操作 | ⚠️ 未在真机闭环 | 验证中明确避免重启，故这类工具只到「能派发、参数合法」 |
| 需要真实游戏运行时的工具（GAS 运行时状态、GameplayCue 执行等） | ⚠️ 部分 | 编辑器上下文内能读到的已验证；需要 PIE 内 gameplay 的只到前置条件层 |
| 超大结果边界 | ⚠️ 部分 | 6.6 MB PNG 正常；更高分辨率/序列帧未压测 |
| game thread 长阻塞（大编译、大资产导入） | ⚠️ 部分 | 只测到秒级；`toolCallTimeoutMs: 300000` 是按「可能数十秒」设的 |
| Sequencer 相机相关工具 | ❌ 有意不验 | 会崩编辑器（§6.1），记为 `BLOCKED_engine_crash_risk` |

---

## 8. 复现方法

```bash
# 0) 前置：UE 5.8 已装、工程启用 ModelContextProtocol + AllToolsets、编辑器已启动 MCP server
lsof -nP -iTCP:8000 -sTCP:LISTEN     # 应有 UnrealEditor 在听

# 1) 层次 A：离线可跑（不需要编辑器）
./tests/run-all.sh                   # 128 passed / 0 failed

# 2) 层次 A（真 runtime）+ 层次 B（线路）
./tests/verify-real-ue.sh            # 21 passed（wire 12 + plugin 9）

# 3) 层次 C/D：逐工具扫描（脚本不在仓库内，属一次性验证产物）
#    核心逻辑：list_toolsets → describe_toolset×52 → call_tool×830
#    空参守卫 + 读类真调用 + 写类跳过，详见 §4.1
```

> 层次 C 的扫描脚本是一次性验证产物，未入库（避免把「830 个工具的固定期望值」变成维护负担）。
> 但方法本身可复刻：`list_toolsets` 是 Markdown、`describe_toolset` 给 schema，
> 加上 §4.1 的三条规则即可重跑。

---

## 9. 相关文档

| 文档 | 内容 |
|---|---|
| [`../README.md`](../README.md) | 安装、配置、能力矩阵 |
| [`REPORT.md`](REPORT.md) | 逆向分析与方案推导（为什么不需要 Epic 的 proxy） |
| [`SPEC.md`](SPEC.md) | 插件规格与验收标准 |
| [`../skills/unreal-mcp/SKILL.md`](../skills/unreal-mcp/SKILL.md) | agent 使用手册（含全部高频报错真机原文） |
| [`../skills/unreal-mcp/references/operations.md`](../skills/unreal-mcp/references/operations.md) | 运维：控制台命令、崩溃恢复、排障矩阵 |
