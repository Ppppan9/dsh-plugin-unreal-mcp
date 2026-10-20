---
name: unreal-mcp
description: 'Drive a live Unreal Editor through the MCP server named unreal: inspect and change the current level, actors, Blueprints, materials, Niagara, Sequencer, Control Rigs, behavior trees, gameplay ability state, UMG widgets, assets, and automation tests. Trigger when the user wants to change, query, or run something inside their Unreal Engine project, or asks to capture the viewport, select actors, inspect the content browser, or run an editor operation that has an MCP tool. Treat Unreal context as given even without the word Unreal when the request mentions .uproject, Content Browser, Outliner, PlayerStart, Live Coding, UE C++ types, or the asset prefixes BP_ WBP_ M_ MI_ NS_ CR_ SK_ SM_ ABP_. Skip for conceptual or documentation questions, and for Unity, Godot, or unrelated uses of blueprint, sequencer, or widget.'
---

# Unreal MCP

你被接到了一个**活的 Unreal Editor**。连接方式：DSH 的官方 MCP 客户端直连编辑器进程里的
`ModelContextProtocol` HTTP/SSE server（默认 `http://127.0.0.1:8000/mcp`，server 名 `unreal`）。
服务端通过 Unreal 的 `ToolsetRegistry` 暴露几百个工具，覆盖 actors / Blueprints / 材质 / Niagara /
Sequencer / Control Rig / 行为树 / GAS / UMG / 资产 / 自动化测试 / Live Coding 等 30+ 个 toolset。

**用它去读和改编辑器状态，不要让用户手动操作。**

## 第一步永远是：先发现，再派发

DSH 只拿到了 **3 个工具**，因为 UE 默认开启 Tool Search（`bEnableToolSearch=true`）：

| 模型侧工具名（DSH 里带 `mcp__unreal__` 前缀） | 作用 |
|---|---|
| `mcp__unreal__list_toolsets` | 列出全部已注册 toolset（含全限定名 + 一句话描述） |
| `mcp__unreal__describe_toolset` | 读某个 toolset 里每个工具的完整 JSON Schema |
| `mcp__unreal__call_tool` | 真正派发一次工具调用，**同一轮返回结果** |

像 `BlueprintTools.create`、`SequencerTools.create_level_sequence` 这类名字**不在工具列表里**，
它们是服务端派发的，永远不会变成原生工具。这是故意的：初始 context 小、prompt cache 稳定。
**所以三工具契约是必需的，不是装饰。**

### 三步

1. **发现**：`mcp__unreal__list_toolsets` 看有哪些 toolset。已知目标（用户说「做个 Blueprint」→
   Blueprint 相关 toolset）可以跳过 list，直接 `describe_toolset` 确认。
2. **描述**：`mcp__unreal__describe_toolset`，参数 `toolset_name` 用 `list_toolsets` 返回的
   **全限定名**。它会给出每个工具的名字、参数 schema、返回 schema、文档。
   **注意**：它返回的 `tools[].name` 是**全限定名**，派发时要自己去掉 toolset 前缀。
3. **派发**：`mcp__unreal__call_tool`，参数三件套：
   ```json
   {
     "toolset_name": "editor_toolset.toolsets.scene.SceneTools",
     "tool_name": "get_current_level",
     "arguments": { }
   }
   ```
   `tool_name` 用**短名**。从 `describe_toolset` 的全限定名
   `editor_toolset.toolsets.scene.SceneTools.get_current_level` 得到短名的规则是：
   **去掉 `<toolset_name>.` 这个前缀**，剩下的就是 `get_current_level`。

`call_tool` 顶层派发（省略 `toolset_name`）只用于直接注册在 MCP server 上的工具，
**对 `call_tool` 自身会被拒绝**。永远带 `toolset_name`。

### 读结果：三个工具返回格式**各不相同**（真机实测，别想当然）

DSH 的 MCP 桥把结果整理成 `{ content: [{ type: "text", text: "..." }] }`。
UE **不返回 `structuredContent`**，结果都在 `content[0].text` 里 —— **但 text 的格式三个工具不一样**：

| 工具 | `content[0].text` 的格式 | 怎么读 |
|---|---|---|
| `list_toolsets` | **Markdown 列表**，不是 JSON | 按行/正则解析，见下 |
| `describe_toolset` | **JSON 对象** | `JSON.parse` → `{name, version, description, tools[]}` |
| `call_tool` | **JSON 字符串** | `JSON.parse` → 通常 `{"returnValue": ...}` 或 `{"result": ...}` |

**`list_toolsets` 的 text 长这样（Markdown，不要 parse）**：

```text
- ToolsetRegistry.AgentSkillToolset: Provides tools for listing, reading, and creating/updating skills.
- EditorToolset.EditorAppToolset: Tools for querying and modifying Unreal Editor state: ...
- editor_toolset.toolsets.scene.SceneTools: Level and scene operations.
```

读法：按行取 `- <全限定名>: <描述>`。**这里有个真机踩过的坑**：
toolset 的「描述」本身是多行 Markdown，里面**还有以 `- ` 开头的子条目**
（例如 `NiagaraToolset_Assets` 的描述里就有 `- GetAssetDiscoveryInfo: ...`，那是工具名不是 toolset）。
所以朴素正则 `/^- \S+: /` 会把它们误算成 toolset —— 实测会把 52 个算成 **55 个**，换台机会算成 **67 个**。

**稳妥的解析正则**：要求名字里**必须含 `.`**（全限定名一定是 `Module.Path.Name`）：

```js
const toolsets = [...md.matchAll(/^- ([A-Za-z_][A-Za-z0-9_.]*\.[A-Za-z0-9_]+): /gm)].map(m => m[1]);
```

本机（UE 5.8 + `AllToolsets` + `UE5McpTest`）实测 **52 个 toolset / 830 个工具**；
数量随工程启用的插件变化，不要写死。

**`describe_toolset` 是标准 JSON**，`tools[]` 里每个元素有 `name` / `description` / `inputSchema`，
`inputSchema.required` 是**字面**语义（见下面的坑）。

**`call_tool`**：

```text
1. 取 content[0].text                        // 一个字符串
2. JSON.parse 它                             // {"returnValue": ...} 或 {"result": ...}
3. 取 .returnValue（或 .result）
```

- 基础类型（数字/字符串/bool）的结果默认被包成 `{"returnValue": ...}`，
  由 CVar `ModelContextProtocol.WrapPODToolResultsInObject`（默认 true）控制。
- **`describe_toolset` 给出的 `tools[].name` 是全限定名**（如
  `editor_toolset.toolsets.scene.SceneTools.get_current_level`），但 `call_tool` 的
  `tool_name` **要用去掉 toolset 前缀的短名**（`get_current_level`）。这是真机上最容易错的一步。

### 双层 JSON：`ObjectTools` 的 `returnValue` 还要再 parse 一次

`ObjectTools.get_properties` / `list_properties` 的 `returnValue` **本身又是一个 JSON 字符串**，
所以要走两次 parse（真机实测）：

```js
const rv = JSON.parse(content[0].text).returnValue;   // 第一层：MCP 包装
const value = JSON.parse(rv);                          // 第二层：ObjectTools 自己序列化的
// get_properties  → value 形如 { intensity: 6, mobility: "Movable", ... }
// list_properties → value 是 { 属性名: schema } 的映射，**它的 key 就是可用属性名**
```

其它工具（`SceneTools` 等）通常只有一层，`returnValue` 直接就是值。**不确定就 try 两层。**

### 属性名不能猜：一个错名会让整次调用失败

真机实测：`get_properties` 只要有一个属性名不存在，**整个调用返回纯文本报错**，
不会给部分结果：

```text
GetObjectProperties on '...LightComponent0' (DirectionalLightComponent):
the following properties could not be read: attenuationRadius, sourceAngle
```

而且这条错误是**纯文本，不是 JSON**（`isError` 甚至可能是 `undefined`），
所以**直接 `JSON.parse` 会抛 `Unexpected token 'G'`**。

**正确做法**（UMG toolset 的文档也是这么要求的）：

```text
1. ObjectTools.list_properties(instance)   // 返回 { 属性名: schema }
2. 从 key 里挑你要的（不要凭记忆写 attenuationRadius 这种）
3. ObjectTools.get_properties(instance, [<真实属性名>])
```

**找组件要用对的引用**：`DirectionalLight` 的组件是 `.LightComponent0`，
而 `SkyLight` 的是 `.SkyLightComponent0` —— 名字不一样。稳妥做法：
先 `get_properties(actor, ['lightComponent'])` 拿到 `refPath`，再读组件属性。
拿不准就先单独试一个属性名，确认存在再批量读。

### 失败会抛错，不是返回值

DSH 的 MCP 桥在收到 MCP `isError: true` 时**直接让工具调用失败**，错误文本原样来自编辑器。
所以：

- 不要去找 `isError` 字段，也不要去读错误结构体 —— 你看到的是**工具调用抛出的异常**。
- 按异常文本对症下药（见下面的「高频报错」）。

**但 transport 成功 ≠ 操作成功。** 很多 Unreal 工具内部失败了也照样返回正常响应，
只在文本里写个 status / success / errors。**parse 完 `returnValue` 之后还要读里面的状态字段**，
不能因为「没抛异常」就宣布成功。Blueprint 编译、Widget 创建、材质连线尤其如此。

### 用 Blueprint 做东西（不写 C++）

`BlueprintTools` 有一整套图操作，**核心是 `write_graph_dsl`**：它吃一段 S-expression，
生成节点并连线，然后自动编译。**动手前必须先 `get_graph_dsl_docs`**，语法很具体。

最小流程（真机实测可跑通）：

```text
1. BlueprintTools.create(folder_path="/Game/Blueprints", asset_name="BP_X",
                          asset_type={"refPath":"/Script/Engine.Actor"})
2. BlueprintTools.get_graph(blueprint, graph_name="EventGraph")
3. BlueprintTools.get_graph_dsl_docs()            ← 必读
4. BlueprintTools.write_graph_dsl(graph, code)     ← 写节点
5. BlueprintTools.compile_blueprint(blueprint, warnings_as_errors=true)
6. BlueprintTools.read_graph_dsl(graph)            ← 回读校验
```

**DSL 的五个真机坑（我逐个踩过）**：

| 坑 | 错误写法 | 正确写法 |
|---|---|---|
| BeginPlay 事件名 | `(event ReceiveBeginPlay)` → `does not exist` | `(event EventBeginPlay)` |
| 三角函数 | `Math\|Float\|sin` → `does not exist` | `Math\|Trig\|Sin(Radians)`（注意括号是名字的一部分） |
| 节点调用要显式 self | `(Transformation\|SetActorLocation (+ a b))` → 把向量接到 self 上 | `(Transformation\|SetActorLocation :self self :NewLocation (+ a b))` |
| 类路径/枚举要加引号 | `(/Script/Engine.Actor)` | `"/Script/Engine.Actor"`（否则报 Undefined variable） |
| 同一个调用别写两遍 | 两处都写 `(Transformation\|GetActorLocation)` 会建**两个节点**、执行两次 | 先 `(bind loc ...)` 再复用 `loc` |

**布尔变量在 DSL 里的节点名会剥掉 `b` 前缀**（真机实测）：

变量名 `bEnabled` → setter 节点是 `Variables|Default|SetEnabled`，**不是** `SetbEnabled`。
getter 同理（`GetEnabled`）。先按「去掉名字开头的 b」拼，报错再试原样。
稳妥做法：`BlueprintTools.list_variables` 拿真实变量名，再拼 Set/Get。

**DSL 的已知边界（真机实测，别依赖）**：

| 写法 | 实际行为 |
|---|---|
| `(switch ...)` | 写入返回成功但**不生成节点**（回读验证会发现缺失） |
| `(bind x (...))` 作为 event 里第一条 | 可能把**整个图清空**；把 bind 放在别的语句之后 |
| 图里已有残失败节点 | 后续 write **不会**清理，会一直留在图里 |
| `(fn Name (params) ...)` 写函数体 | ✅ 可用，且编译通过 |

→ **结论：每次 `write_graph_dsl` 之后必须 `read_graph_dsl` 回读核对**，
只报"成功"不算数。发现节点缺失就重建蓝图（新蓝图 + 重写），不要往脏图上追加。

**找节点类型别靠猜**：`find_node_types(graph, type_id_filter="Math|Trig", context_pins=[])`
返回真实 type_id。注意 `find_node_types` 必须带 `graph` 和 `context_pins`（可为空数组）。

**验证蓝图真的在跑**（重要，别只看编译通过）：

```text
1. SceneTools.add_to_scene_from_class 把蓝图实例放进关卡
   （actor_type 用 "/Game/Blueprints/BP_X.BP_X_C"，注意结尾的 _C）
2. EditorAppToolset.StartPIE({options:{bSimulate:false, playMode:"PlayMode_InViewPort", warmupSeconds:2}})
3. EditorToolset.LogsToolset.GetLogEntries(category="LogBlueprintUserMessages", pattern="你的关键字")
   → 能读到 PrintString 的输出，说明 BeginPlay 真的跑了
4. 用 ActorTools.get_actor_transform 连续采样，看数值是否随时间变化 → 证明 Tick 在跑
5. EditorAppToolset.StopPIE()
```

**注意 PIE 里 actor 的 refPath 会变成 `/Memory/UEDPIE_0_...` 前缀**，不是 `/Temp/...`。
查 PIE 里的 actor 要用 `find_actors` 重新找，别拿编辑器世界的旧 refPath。

### 各 toolset 的参数名风格**不统一**（真机实测）

这是最容易反复踩的坑。同一类操作，不同 toolset 的参数名不一样：

| toolset | 风格 | 实例 |
|---|---|---|
| SceneTools / ObjectTools / ActorTools / MaterialTools | snake_case | `toolset_name`、`actor_type`、`refPath`、`material_or_function` |
| **UMGToolSet** | **camelCase** | `folderPath`、`assetName`、`parentClass`、`widgetBlueprint`、`widgetClass` |
| **SequencerTools** | snake_case 但**命名独特** | 建序列是 `package_path` + **`asset_name`**（没有 `name`/`folder_name`）；`actor_class_path`、`track_type` |
| MaterialInstanceTools | snake_case | `instance`、`name`、`value` |
| **UMGToolSet** | camelCase，但 **class 参数的类型是反的** | `AddWidget.widgetClass` 要 **对象引用** `{"refPath":"/Script/UMG.Button"}`；`CreateWidgetBlueprint.parentClass` 要 **字符串** `"/Script/UMG.UserWidget"` |
| Niagara 系 | 结构体引用 | `system` / `emitterName` / `scriptName` / `rendererIndex` 组成一个栈引用，**不是**一条软路径 |
| PCGToolset | snake_case | `graph` / `node` / `fromPinLabel` / `toPinLabel`；pin 名要用 `GetNodeInfo` 读（Input 节点是 `In`，Output 节点是 `Out`） |
| DataTableTools | 混用 | `set_rows.values` 是 **JSON 字符串**，`rename_rows.renames` 是 **JSON 对象** —— 两者相反 |

**别猜参数名**：`describe_toolset` 会给出 `inputSchema.required` 和 `properties`，
报错文本里也会附带完整 schema。**先看 schema 再调**，比试错快得多。

另外注意：**工具名也可能和你想的不同**。例如材质的创建工具是 `create_material` 而不是 `create`，
Blueprint 的创建工具才是 `create`。用 `describe_toolset` 列全量工具名确认。

### 同一个操作，不同 toolset 的**参数形状**也不一样（真机实测）

名字对了不代表形状对。以下都是实测踩出来的：

| 现象 | 正确写法 |
|---|---|
| Niagara `SetRendererData` 的 `rendererData` | **对象里套 JSON 字符串**：`{"propertyValues": "<JSON 字符串>"}`；且只有部分属性可写（`SourceMode`/`MacroUVRadius` 可写，`Alignment` 不可写） |
| Niagara 栈引用 | `{"system":{"refPath":...},"emitterName":"...","scriptName":"...","rendererIndex":0}` |
| UMG `AddWidget` | `widgetClass` 用对象引用；**要嵌套必须显式传 `parentWidget`**，否则只能加到根 |
| UMG `MoveWidget` | `widget` / `newParent` 都要**控件实例**的 refPath（`...:WidgetTree.Name`），`newParent` 必须是 `PanelWidget` |
| UMG `SetNamedSlotContent` | `hostWidget` 必须实现 `INamedSlotInterface`；`widgetClass` 用对象引用 |
| DataTable `get_rows` | `row_names: []` 会报 `Expecting value`；读全部用 `list_rows` |
| DataTable `set_rows` | `values` 必须是 **JSON 对象**（`{"RowName":{...}}`），传数组报 `values must be a JSON object, got list.` |
| DataTable `create` | `schema` 传 **UScriptStruct 纯字符串** `"/Script/UMG.RichTextStyleRow"`（传对象引用会被拒） |
| PCG 连边 | `fromPinLabel`/`toPinLabel` 用 `GetNodeInfo` 读到的**真实** pin 名（Input 节点是 `In`，Output 节点是 `Out`） |
| Sequencer `add_actors_by_name` | 传的是 actor 的 **label**，不是 refPath 尾段；先 `ActorTools.set_label` |

### 用 Python 编排多个工具（ProgrammaticToolset）

`ProgrammaticToolset.execute_tool_script` 提供一个**受限 Python 沙箱**，
可以在一个调用里串联多个工具、做条件判断和统计。

```python
def run():
    level = execute_tool("editor_toolset.toolsets.scene.SceneTools.get_current_level", "{}")["returnValue"]
    data = execute_tool("editor_toolset.toolsets.scene.SceneTools.find_actors",
                        "{\"name\":\"\",\"tag\":\"\",\"collision_channels\":[]}")
    actors = data["returnValue"]
    lights = [a for a in actors if "Light" in a["refPath"]]
    return {"level": level, "actor_count": len(actors), "light_count": len(lights)}
```

**沙箱的真实规则（真机实测）**：

| 规则 | 事实 |
|---|---|
| 入口函数 | 必须是 `def run():`，顶层 `return` 会报 `'return' outside function` |
| 工具名 | 第一个参数必须是**全限定名**（`editor_toolset.toolsets.scene.SceneTools.get_current_level`）。传短名 `SceneTools.get_current_level` 会报 `ToolsetIsNotRegistered: SceneTools is not registered` |
| 入参 | `execute_tool(tool_name, json_input)` 的第二个参数是 **JSON 字符串**，传 dict 会 TypeError |
| 返回 | 直接返回 dict；`execute_tool` 返回的是已解析的 `_StrictDict`，**不要**再 `json.loads` |
| 白名单模块 | 只有 6 个：`math`、`re`、`json`、`time`、`datetime`、`copy` |
| `import unreal` | ❌ 被拒：`Import of 'unreal' is not permitted` |
| `open()` | 只读 |

适合用来做：批量统计、条件筛选、多步只读查询的合并。**不适合**做复杂逻辑——沙箱就是干这个的。

### 慢是正常的

`call_tool` 阻塞到 game thread 执行完毕才返回。重编译、资产导入/保存、批量操作可能几十秒到几分钟。
这个 bundle 把 `toolCallTimeoutMs` 设成了 300000（5 分钟）。**不要因为慢就判定失败或重试** ——
重复派发一个已经在跑的变更操作会造成重复创建。

## 高频报错（真机实测原文，照着改就好）

| 报错文本（截断） | 原因 | 修法 |
|---|---|---|
| `Unknown tool <全限定名>` | 你把**全限定名**传给了 `tool_name` | 去掉 `<toolset_name>.` 前缀，用短名 |
| `input param "X" needs a default value` | 该参数是**没有默认值的 `TOptional`**，被省略了 | **显式传 `null`**。关键：`schema` 里所有没有 `default` 的可选结构体参数**都必须出现**，漏一个就报错（`CaptureViewport` 要同时给 `captureTransform: null, annotations: null`） |
| `input params are required by the function input schema ..., but incoming ... is empty` | 缺的是**必填**参数（不是 TOptional） | 用 `describe_toolset` 读 `inputSchema.required`，按名字补上。报错文本里会附带完整 schema |
| `no valid session ID provided` | **编辑器重启过**，DSH 仍持有旧 MCP session（已知限制） | **停止重试**，告诉用户：Web 侧边栏 Plugins → `Unreal Engine MCP` → 关掉再打开。详见 `references/operations.md` §D |
| `GetObjectProperties on '...' (...) : the following properties could not be read: X, Y` | 属性名猜错（**纯文本，不是 JSON**） | 先 `list_properties` 拿真实属性名；见上面「属性名不能猜」 |
| `Parameter error: ... is not valid Object for property 'instance'` | 组件 refPath 写错（如把 SkyLight 的组件写成 `LightComponent0`） | 先读 actor 的 `lightComponent` 属性拿正确 refPath |
| `Unexpected token 'G'` / `Unexpected token 'P'` | 对**纯文本报错**做了 `JSON.parse` | 说明上一步调用其实失败了；先看原始 text 再决定 |
| `Unknown tool <名字>` | 工具名记错了（如 `create` vs `create_material`） | `describe_toolset` 列全量工具名 |
| `Parameter "X" is not a <类型> parameter on the material` | 材质参数还没定义 | 先用 `MaterialTools` 加参数，再设值 |
| `is not valid Enum for property 'Enum'` | 枚举路径写错 | 用 `NiagaraToolset_Info.UEnum_Info` 查真实枚举路径 |
| `'return' outside function` | Python 脚本没写 `run()` | 改成 `def run(): ...` |
| `the JSON object must be str, bytes or bytearray, not dict` | `execute_tool` 入参传了 dict | 第二个参数传 **JSON 字符串** |
| `Import of 'unreal' is not permitted` | 沙箱禁了 `unreal` 模块 | 只用白名单 6 个模块；要碰引擎就走普通工具 |
| `The node could not be created / AddEvent\|X does not exist` | DSL 里的事件名不对 | BeginPlay 用 `EventBeginPlay`，Tick 用 `EventTick`；查 `BlueprintTools.list_events` |
| `Could not connect pin ReturnValue to self` | 节点调用的第一个位置参数被当成了 self | 显式写 `:self self`，再用 `:PinName` 传参数 |
| `Unknown variable "X"` | 类路径/枚举没加引号 | 加双引号：`"/Script/Engine.Actor"`、`"AlwaysSpawn"` |
| 工具跑了但属性没生效 | 属性名写错（大小写 / 漏了 UE 的 `b` 前缀） | 用 `describe_toolset` 里的原名：`bUseTemperature`、`mobility`，不是 `useTemperature` |
| `set_properties` 报解析错误 | `values` 要的是 **JSON 字符串**不是对象 | `{"values": "{\"intensity\": 10.0}"}` |
| 对象引用报错 | 引用的形状不对 | 一律 `{"refPath": "<soft object path>"}`；spawn/find 的返回里带 refPath，抓住复用 |
| `list_toolsets` 调用失败（其他报错） | 编辑器没开 / server 没起 / 端口不对 | 见 `references/operations.md` §A |
| `Log category 'LogsToolset' not found` | `LogsToolset` 的 `category` 默认值是坏的（默认 `"LogsToolset"` 不是真 category） | **显式传 `category`**：`GetVerbosity`/`GetLogEntries` 要给 `{"category":"LogTemp"}`，否则一定失败 |
| `Timed out waiting for asset selection`（约 5.6s） | `SelectAssets` 传了**包路径** `/Game/A/B` | 传**对象路径** `/Game/A/B.B`。另外 `GetSelectedAssets` 不会回读这个选择（两边不对称），别拿它做断言 |
| `Unable to convert position into screen space` | `WorldPosToScreenCoords` 的点在相机背后/不在视锥内 | 先 `GetCameraTransform` 算清朝向再取点；俯视时把相机抬高、pitch 设 -90 |
| `Unable to find a solid surface at the given screen coordinates` | `ScreenCoordsToWorld` 的屏幕射线没打到任何表面 | 让相机朝向有几何体的方向，或把 `traceDistance` 调够大 |
| `Asset type does not support image capture` | `CaptureAssetImage` 只能截**支持缩略图**的资产类型（材质实例 ✅；Blueprint / LevelSequence / WidgetBlueprint ❌） | 换支持的资产类型；要看关卡就 `CaptureViewport` |
| `ToolsetIsNotRegistered: <X> is not registered` | `execute_tool` 传了短 toolset 名 | 传全限定名，见「用 Python 编排多个工具」 |
| 端口在 LISTEN 但每个请求被 reset / 无限挂住，编辑器窗口是开着的 | **崩溃后重启**弹了「Restore Packages」模态框，阻塞 game thread（不是 MCP 坏了！） | 点掉模态框，或按 `references/operations.md`「崩溃之后」清 `Saved/Autosaves` 后重启 |
| 编辑器闪退，栈里有 `FCameraCutTrackEditor::Tick` | Sequencer 里有 `MovieSceneCameraCutTrack` 会触发 UE 5.8 断言 | 别加 camera cut track / 相机绑定；见 `references/operations.md` |
| 编辑器闪退，栈里有 `FWidgetBlueprintOperationUtils::WrapWidgets` | `UMGToolSet.WrapWidgets` 在批量操作控件时踩空指针 | 不要用 `WrapWidgets`；`ReplaceWidgetWith*` 的 `widgetToReplace` 为空也会失败 |
| `No stack issue with IssueId '…' was found` | Niagara 的 issue `fixes` 数组是空的 | 先 `GetStackIssues` 看 `fixes` 有没有内容 |
| `GFP not found: <name>` | 本工程没启用任何 Game Feature Plugin | `ListDiscoveredGameFeaturePlugins` 返回空就是这个原因 |
| `Embedding generation failed: HTTP 401 … You didn't provide an API key` | SemanticSearch 需要外部 embedding 服务与 API key | 在 Project Settings → Plugins → Semantic Search 填 `EmbeddingApiKey` / `CaptioningApiKey`；或用本仓库的 `tools/setup-semanticsearch.sh`（DeepSeek 看图 + 本机向量，零成本，已实测跑通）。详见 `references/operations.md` |
| `check(QueryVector.Num() == Dimension)` 断言 + 编辑器闪退 | 运行中改了 `EmbeddingDimension`，UE 拿旧维度索引查新维度向量 | **维度必须在编辑器启动前定好**；改完删掉 `<Project>/Saved/SemanticSearch/SearchIndex.bin` 再重启 |
| `Indexing failed … Thumbnail compressor is null` | 该资产没有缩略图，索引器拿不到图 | 复制/重复出来的资产常无缩略图；换成材质、静态网格等自带缩略图的资产 |
| `The SemanticSearch index is empty` | 索引还没建 | 保存一个带缩略图的资产（`bAutoIndexOnSave=True` 会自动建），或控制台 `SemanticSearch.IndexAll` |
| `The SemanticSearch index is empty` | 同上，索引没建 | 同上 |
| `does not implement INamedSlotInterface` | UMG 宿主控件必须实现该接口 | 换控件类型，或换个目标 |
| `is not valid MovieSceneSequence` | Sequencer `binding.sequence` 要 `MovieSceneSequence` 对象 | LevelSequence 的内部序列无法用软路径表达，这条路径在本机走不通 |

**两种「缺参数」要分清**：`needs a default value` = 该参数是 `TOptional`，传 `null` 即可；
`are required by the function input schema` = 真的必填，必须给值。
报错文本里通常**直接附带完整 schema**，照着它补参数最快。

**特别提醒 `no valid session ID provided`**：这不是你参数写错，重试多少次都不会好。
唯一解法是让用户重建连接。**不要反复重试**，直接说明情况并给出操作步骤。

几个必须背下来的语义：

- **`TOptional` 必须显式传 `null`**，省略会直接失败。
- **schema 的 `required` 是字面语义**。`find_actors` 把 `name` / `tag` / `collision_channels`
  标成 required（语义上可选）；要表达「任意」就传 `""` / `[]`。
- **对象引用**统一 `{"refPath": "<soft object path>"}`：类引用像 `/Script/Engine.PointLight`，
  actor 引用是完整路径 `/Temp/Untitled_1.Untitled_1:PersistentLevel.DirectionalLight_UAID_...`。
- **属性名 camelCase 且保留 UE 的 `b` 前缀**。写错不会让整个 call 失败，但响应里会逐个列出设置失败的属性名。

## 安全规则

这些是保命的，不是客套。

- **先存，再改，再存。** 批量变更前让用户保存（或自己调 `AssetTools` 的 save），改完再存一次。
  MCP 的编辑不总能 undo，跨编译边界尤其如此。碰多个资产的操作，一律当作需要恢复点的破坏性操作。
- **等编译。** C++ / shader 编译在跑的时候派发，会挂住或者以很难懂的方式失败。
  要从运行中的编辑器重编译 C++，用 `LiveCodingToolset.CompileLiveCoding` 并等它的结果 ——
  它会阻塞到编译真正结束，并吐出 MSVC 诊断。不要让用户切回 IDE。
- **串行化依赖调用。** MCP 接受并发请求并做了派发同步，但异步工具会重叠，请求顺序不保证执行/完成顺序。
  依赖关系和会改同一份资产/编辑器状态的变更必须串行。只有确认互不影响的独立读操作才并行。
  多个 agent 可以共用一个编辑器，但冲突修改会造成很难查的问题。
- **确认结果。** 见上面「transport 成功 ≠ 操作成功」。
- **注意 PIE。** 资产创建类工具在 Play-in-Editor 跑着的时候行为不同。结果看着不对，先检查 PIE 并停掉。

## 项目级 Agent Skill

工程或插件可以注册 **Agent Skill**：命名好的指令包，装着 agent 本来不知道的工程约定
（命名规范、目录布局、必做步骤、多步任务的规范顺序）。它们**不在 `list_toolsets` 里**，
走的是 `AgentSkillToolset`。

在不熟悉的工程里开始干活时，先查一次（不是只查一次就完事）：

1. `mcp__unreal__call_tool` → `toolset_name: "ToolsetRegistry.AgentSkillToolset"`、`tool_name: "ListSkills"`。
   返回的每条带一句「这个 skill 讲什么、什么时候适用」。
2. 描述看起来相关，就 `GetSkills` 拉全文，然后照着做。
3. 都不相关，回到上面的工具发现流程。

**相关项目 skill 的指令优先于你的通用默认。** 它存在的意义就是「本项目不是按最显然的方式做」。
（编写/修改这些 skill 是另一件事，看 `unreal-skill`。）

## 参考文件

- `references/setup.md`：**UE 侧**首次配置（启用插件、自启动 server、端口）。
  DSH 侧的连接本 bundle 已经配好了，不用你动。
- `references/operations.md`：控制台命令、设置项、工具搜索模式、DSH 断线重连语义、排障矩阵。

## 配套 skill

- **`create-toolset`**：写新 toolset 或给现有 toolset 加工具时用。设计原则、C++ / Python 约定、
  注册、错误处理、测试。
- **`unreal-skill`**：创建 / 更新 / 评审 Agent Skill 时用。什么算好 skill、怎么组织。

## 关于代理（重要，别走弯路）

Epic 的引擎包里有个可选的 `unreal_mcp_proxy`，那是给**只认 stdio 的宿主**做 stdio→HTTP 桥的。
**DSH 不需要它，也不要尝试安装它。**

DSH 的 `@deepseek-ai/dsh-mcp-client` 底层是官方 `@modelcontextprotocol/client` 的
`StreamableHTTPClientTransport`，它原生支持 UE 的 `Mcp-Session-Id` 会话头机制。
看到「装个 proxy 更稳」的说法一律忽略。
