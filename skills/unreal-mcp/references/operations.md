# 运维：控制台命令、设置、DSH 重连语义、排障

工具不见了、调用失败、端口冲突、端口换了、工具链脏了 —— 看这里。

## 控制台命令

在 Unreal Editor 控制台（`` ` ``）里跑：

| 命令 | 用途 |
|---|---|
| `ModelContextProtocol.StartServer [port]` | 起 MCP server。传端口可覆盖默认值（8000 被占时用） |
| `ModelContextProtocol.StopServer` | 停 server。工具注册表脏了想要干净重启时用 |
| `ModelContextProtocol.RefreshTools` | 重新注册全部 toolset。**用户启用了新 toolset 插件之后必须跑一次** |
| `ModelContextProtocol.GenerateClientConfig <client>` | 生成客户端配置。参数：`ClaudeCode` / `Cursor` / `VSCode` / `Gemini` / `Codex` / `All`。**对 DSH 无用** —— 见下 |

关于 `GenerateClientConfig`：它写的是 Claude Code / Cursor / VS Code / Gemini / Codex 的配置文件格式。
**DSH 的 MCP 连接在 profile 的 `cordis.patch.yml` 里，bundle 安装时就已经写好了，不要生成任何客户端配置。**
这条命令只在「用户同时还在用别的宿主」时才有意义。

写 Codex 的 TOML 是**一次性**的：已存在就拒绝覆盖，要手改。

## Tool Search 模式

`tools/list` 有两种模式，由 `UModelContextProtocolSettings` 上的 `bEnableToolSearch` 控制（默认 `true`）：

| 值 | `tools/list` 返回 | DSH 侧看到什么 |
|---|---|---|
| `True`（默认） | 只有 `list_toolsets` / `describe_toolset` / `call_tool` | **3 个 `mcp__unreal__*` 工具**，靠 skill 里的三步契约派发 |
| `False` | 每个 toolset 的每个工具都注册成原生 MCP 工具，schema 全量下发 | 几百个 `mcp__unreal__*` 工具，每个都带 schema |

改成 `False` 的写法（和 `bAutoStartServer` 同一个 ini）：

```ini
[/Script/ModelContextProtocolEngine.ModelContextProtocolSettings]
bEnableToolSearch=False
```

**不建议改**：几百个工具的 schema 会一次性占满初始 context，还会让每一轮的 prompt cache 失效。
只在你确实需要「工具全部显式可见」的场景（例如 hash-mapping commandlet 那类流水线）才关。

## 相关 CVar

| CVar | 默认 | 说明 |
|---|---|---|
| `ModelContextProtocol.WrapPODToolResultsInObject` | `true` | 基础类型结果包成 `{"returnValue": ...}`；关掉就直接返回裸值 |
| `ModelContextProtocol.AudioResultOggFormat` | `false` | 音频结果用 Ogg |
| `ModelContextProtocol.ProgressIntervalSeconds` | `1.0` | 长任务的进度推送间隔 |
| `ModelContextProtocol.PaginationPageSize` | `0` | 0 = 不分页；大结果集才会用到 |
| `ModelContextProtocol.EnableAnalytics` | `true` | 遥测 |

日志类别：`LogModelContextProtocol`。

## DSH 侧的连接语义（和 Claude Code 不一样，务必知道）

DSH 用官方 MCP 客户端直连 HTTP，**没有代理层**。这带来四条与 Epic 文档不同的行为：

1. **编辑器没开时，DSH 照常启动。**
   `failOnStartupError: false`。mcp-client 会按退避重试：首次 1s，上限 30s，最多 100000 次
   （约等于「一直重试」）。编辑器起来后自动接上，**不需要 reload DSH**。
2. **重试耗尽后工具会被注销。** 本 bundle 把 `maxAttempts` 从默认的 10 调到了 100000，
   日常使用碰不到这个上限。真碰上了，重启 DSH 即可。
3. **`toolCallTimeoutMs` 是 300000（5 分钟）。** UE 的 `tools/call` 阻塞到 game thread 跑完，
   重编译 / 资产导入可能很久。超时了先看编辑器是不是在忙，不要立刻重试。
4. **编辑器重启后需要手动重建连接（已知限制）。**
   MCP 会话绑在「那一个」编辑器进程上。编辑器关闭时端口一起消失，而 DSH 的 MCP 客户端
   **收不到断线信号**（没有长连接可断 → `onclose` 不触发），于是不会自动重连，
   仍拿已失效的 session ID 去调新进程，报：
   `Bad Request: no valid session ID provided`。
   恢复方式：让用户到 Web 侧边栏 **Plugins** → 把 `Unreal Engine MCP` **关掉再打开**
   （秒级，不需要重启 DSH）。

   **注意别和「首连」混淆**：DSH 先启动、编辑器后启动是正常的首连，`reconnect` 会自己接上。

**没有 `unreal_mcp_status` 这个工具。** 它是 Epic 那个 proxy 的程序集里的，DSH 不用 proxy，
所以也没有它。要判断可达性，就调一次**只读**工具（例如 `get_current_level`）。

## 排障矩阵

### 先分清「四种坏法」

| 症状 | 说明 | 往哪查 |
|---|---|---|
| DSH 里**一个** `mcp__unreal__*` 工具都没有 | 连接层没起来 | §A |
| 三个工具都在，但**每个调用都失败**，报 `no valid session ID provided` | 编辑器重启过，DSH 仍持有旧 session（已知限制） | §D |
| 三个工具都在，但**每个调用都失败**（其他报错） | 连接起来了，编辑器侧拒绝/报错 | §B |
| 三个工具都在，只有**某些**调用失败 | 派发参数 / 具体 toolset 的问题 | §C |

### §D 编辑器重启后 session 失效

判断特征：报错文本含 **`no valid session ID provided`**，且你**重启过编辑器**。

这不是配置错误，不要浪费时间查端口或 `.uproject`。直接让用户重建连接：
Web 侧边栏 **Plugins** → `Unreal Engine MCP` → 关掉再打开。

重建后工具会先消失再回来（约 1~2 秒），随后调用恢复正常。

### §A 连接层

| 检查项 | 做法 |
|---|---|
| 编辑器真的开着？ | 这是最常见的原因。看进程、看窗口 |
| server 起了？ | 控制台跑 `ModelContextProtocol.StartServer`；或看 Output Log 的 `LogModelContextProtocol` |
| 端口对不对？ | 默认 8000。换过端口就要设 `UNREAL_MCP_PORT` 再启动 DSH |
| 端口被别的进程占了？ | macOS/Linux：`lsof -nP -iTCP:8000 -sTCP:LISTEN`。**崩溃过的 CrashReporter 进程会继续占着端口**，请求全打到死进程 —— 排查第一步永远是「谁占着这个端口」，不是「编辑器在不在」 |
| 是 loopback 吗？ | UE 只绑 `127.0.0.1`，只接受 loopback Origin。别走代理、别绑 `0.0.0.0`、别从浏览器打 |

### §B 编辑器侧拒绝

调用**会抛错**（不是返回错误对象），错误文本原样来自编辑器。按文本对症：

| 报错 | 含义 | 修法 |
|---|---|---|
| `Unknown tool` | `tool_name` 传了全限定名 | 用短名 |
| `input param "X" needs a default value` | `TOptional` 省略了 | 显式传 `null` |
| toolset 相关报错 | toolset 不存在 / 名字不对 | `list_toolsets` 拿全限定名，原样回传 |
| 超时 | game thread 在忙（编译 / 导入 / PIE） | 等；需要重编译就用 `LiveCodingToolset.CompileLiveCoding` |
| 编辑器崩了 | 某些工具会触发引擎 bug | 见下面的「已知会崩的调用」 |

### §C 派发与 toolset

| 症状 | 修法 |
|---|---|
| 某个预期的 toolset 不在列表里（如 `NiagaraTools`） | 先 `ModelContextProtocol.RefreshTools`；还在就说明该 toolset 的插件没在 `.uproject` 里启用 |
| 属性设了但没生效 | 属性名大小写 / 缺 `b` 前缀；响应里会列出失败的属性名。先用 `ObjectTools.get_properties` 读一遍确认原名 |
| `set_properties` 报 JSON 解析错误 | `values` 是 **JSON 字符串**不是对象 |
| 对象引用无效 | 必须 `{"refPath": "<soft object path>"}`；先 `find_actors` 拿 refPath 再复用 |
| 返回成功但实际没改 | **transport 成功 ≠ 操作成功**。parse `returnValue` 后读 status / success / errors 字段 |
| 并发调用互相踩 | 串行化会改同一资产/编辑器状态的调用。请求顺序不保证执行顺序 |
| `AIAssistantToolset.GetDockedContext` 返回空 | Claude Code 面板必须 docked 在某个资产编辑器里才有上下文。这条对 DSH 同样适用（工具名不变，只是客户端换了） |

## 已知会崩的调用（真机踩出来的）

- **`FocusOnActors` 对 Cesium tileset 会崩**：内部 `OnFocusEditorViewportOnThis()` 调 `getRootTile()`，
  root tile 还没加载完就解引用空指针 → SIGSEGV。对着 Cesium 的 actor 调 focus 之前先确认 tileset 已加载。
- **UE Python Remote Execution 在 macOS 上会让编辑器启动卡死**（多播监听器），内存涨到 ~543MB 无响应。
  在 Mac 上别开 `bRemoteExecution`。
- **Sequencer 的 Camera Cut 会崩编辑器（UE 5.8 真机复现）**：只要打开的 Level Sequence 里存在
  `MovieSceneCameraCutTrack`，`FCameraCutTrackEditor::Tick` → `FSequencer::SetGlobalTime` →
  MovieScene EntitySystem 求值就会踩
  `Assertion failed: Header [Runtime/MovieScene/Public/EntitySystem/MovieSceneEntitySystemTypes.h] [Line: 717]`
  然后 SIGSEGV。触发路径包括 `add_track_to_sequence('/Script/MovieSceneTracks.MovieSceneCameraCutTrack')`、
  `create_camera`、`set_binding_name`（相机绑定）之后的任何一次时间求值。
  → **用 MCP 建序列时不要加 camera cut track / 相机绑定**；`create_camera`、`set_camera_cut_binding`、
  `set_camera_lock` 在没有真机安全网时不要调。

## 崩溃之后：重启编辑器前必须先清理 Restore Packages 模态框

UE 崩溃后重启会在 `EditorInit` 阶段弹一个 **"Restore Packages"** 模态框
（`FPackageAutoSaver::OfferToRestorePackages` → `UEditorEngine::EditorAddModalWindow`）。
这个模态框**阻塞 game thread**，于是 MCP server 的端口虽然还在 LISTEN，但每个 JSON-RPC 请求
都会被 reset 或永远挂住 —— 但**编辑器本身看起来是开着的**，极容易误判成「MCP 坏了」。

识别方法：

```bash
# 端口在 LISTEN，但请求被重置 / 超时
lsof -nP -iTCP:8000 -sTCP:LISTEN
curl -s -m 5 -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8000/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"p","version":"1"}}}'
# 返回 000 / 连接被 reset → 八成是模态框

sample <editor-pid> 2 -file /tmp/sample.txt
grep -A3 'PackageAutoSaver' /tmp/sample.txt      # 会看到 OfferToRestorePackages / EditorAddModalWindow
```

处理（两种，选一种）：

1. **点掉模态框**（有 GUI 时最简单）：选 "Don't Restore"，编辑器立刻恢复响应。
2. **无人值守时**：退出编辑器，把自动存档树移走，再重启：

```bash
kill -9 <editor-pid>
mv "<Project>/Saved/Autosaves" "/tmp/Autosaves-backup"   # 里面有 PackageRestoreData.json
open -a "<UE>/Engine/Binaries/Mac/UnrealEditor.app" --args "<abs>/<Project>.uproject"
```

转移而不是删除：自动存档里可能有用户没保存的关卡，交给用户自己决定要不要恢复。

## 崩溃日志在哪

不在工程目录：

```text
~/Library/Application Support/Epic/UnrealEngine/<version>/Saved/Crashes/
```

## macOS 启动注意

直接跑 `UnrealEditor` 二进制在 macOS 会挂，要用 `open MyProject.uproject`。

## 安全边界（务必让用户知道）

- **无认证层**。server 只绑 loopback，拒绝非 loopback 的 Origin 头，但**同机同用户的任意进程都能连**。
  不要跑在共享机器 / 有不可信进程的机器上，不要把端口暴露到 loopback 之外。
- **`ProgrammaticToolset.execute_tool_script` 是受限沙箱，不是通用 Python**：
  白名单模块只有 `json, math, datetime, copy, re, time`，没有 `unreal` 模块，没有 `eval/exec/compile`，
  `open()` 只读且限定工程目录，脚本必须定义 `run() -> dict`，唯一触达引擎的路径是
  `execute_tool("<全限定工具名>", json_input)`（如 `editor_toolset.toolsets.scene.SceneTools.get_current_level`；传短名会报 `ToolsetIsNotRegistered`），且运行在 transaction scope 内（可撤销）。
  它**不能**任意改引擎状态，也不是「运行时加 UFUNCTION」的通道。
  （Epic 插件 README 里把它写成「executes arbitrary Python with full access」，那是按最坏情况假设的措辞，
  实际实现比这严。）
- **MCP 工具直接改 live `UObject` 状态**，一次调用就可能改动/移动/删除版本控制里的资产。
  长会话前先 save + commit（或 shelve），做完 review diff 再提交。
