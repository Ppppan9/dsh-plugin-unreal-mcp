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
- **UMG `WrapWidgets` 会崩编辑器（UE 5.8 真机复现）**：`UMGToolSet.WrapWidgets` 内部调
  `FWidgetBlueprintOperationUtils::WrapWidgets` → `UWidgetTree::FindWidgetParent` → `UWidget::GetParent()`，
  传入的控件引用若父链断裂就解引用空指针 → SIGSEGV（`access memory at address 0x38`）。
  批量改控件树时不要用它；`ReplaceWidgetWith*` 系列在 `widgetToReplace` 为空时也会失败
  （`None is not valid value for property 'WidgetToReplace'`）。
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

## 哪些功能在本机**不可用**（环境限制，不是工具坏了）

| 工具 | 原因 | 怎么确认 |
|---|---|---|
| `SemanticSearchToolset.Search` / `FindSimilar` | 需要外部 embedding 服务与 API key | 报 `Embedding generation failed: HTTP 401` / `The SemanticSearch index is empty` |

### 怎么给 SemanticSearch 配 API key（`Search` / `FindSimilar` 唯一的依赖）

UE 5.8 的 `SemanticSearch` 插件用 **OpenAI 兼容协议**：拿资产缩略图去 `/chat/completions` 生成
tag + caption，再把 caption 发到 `/embeddings` 生成向量，最后存进本地向量索引做混合检索。
**没有 embedding 服务，这 2 个工具就完全不可用**（跟本插件无关，是引擎侧设计）。

配置在 **Project Settings → Plugins → Semantic Search**（对应 ini 段
`[/Script/SemanticSearch.SemanticSearchSettings]`）：

| 设置 | 默认值 | 说明 |
|---|---|---|
| `CaptioningBaseUrl` | `https://api.openai.com/v1` | 视觉模型端点，插件自动补 `/chat/completions` |
| `CaptioningApiKey` | *(空)* | 发 `Authorization: Bearer <key>` |
| `CaptioningModel` | `gpt-5.4-mini` | 要**能看图**的模型 |
| `EmbeddingBaseUrl` | `https://api.openai.com/v1` | 插件自动补 `/embeddings` |
| `EmbeddingApiKey` | *(空)* | 发 `Authorization: Bearer <key>` |
| `EmbeddingModel` | `text-embedding-3-small` | |
| `EmbeddingDimension` | `512` | 改了会让整个索引重建 |

### 到底要什么「API」？—— 需要**两个**独立的服务，不是一个

读源码（`OpenAIEmbeddingProvider.cpp`）后确认，UE 5.8 的 SemanticSearch 走**两条**独立的 HTTP 调用：

| # | 端点 | 请求体 | 响应要求 | 谁能干 |
|---|---|---|---|---|
| ① **caption**（建索引时） | `POST {CaptioningBaseUrl}/chat/completions` | `{model, messages:[{role,content:[{type:text|image_url,…}]}], response_format:{type:"json_schema", json_schema:{name, strict:true, schema}}}` | `choices[0].message.content` 必须是**符合 schema 的 JSON 字符串** `{tags:[string], caption:string}`；`finish_reason` 必须是 `stop` | **必须支持视觉（能看图）** + **必须支持 `json_schema` 结构化输出** |
| ② **embedding**（建索引 + 每次查询） | `POST {EmbeddingBaseUrl}/embeddings` | `{model, input, dimensions}` | `data[0].embedding` 是**数字数组** | 任何 OpenAI 兼容的 embedding 服务 |

**为什么必须支持视觉**：6 个资产处理器（StaticMesh / SkeletalMesh / Material / MaterialInstance /
Texture / Blueprint）**全部**继承 `ThumbnailBaseProcessor`，都会把资产缩略图（PNG，base64 data URL）
塞进 chat/completions 的 `image_url` part。**没有缩略图 → 该资产直接 `PreProcessor` 失败跳过**，
不会退化成纯文本。UE 自带的提示词也明确要求模型"描述可见内容"。

**为什么 `EmbeddingDimension` 要对**：UE 把 `dimensions` 传给服务端，**并按返回向量长度懒初始化索引**
（`EnsureInitialized(Embedding.Num())`）。服务端若忽略 `dimensions` 返回别的长度，
第一次建索引就带着错维度，之后检索全废。**改这个值 = 整个索引重建**。

**三条可行路径**：

| 方案 | 需要你提供什么 | 成本 | 备注 |
|---|---|---|---|
| **A. OpenAI 官方** | 1 个 key（<https://platform.openai.com/api-keys>） | embedding 按 token 计费（`text-embedding-3-small` 很便宜）；caption 用 `gpt-5.4-mini` 这类**视觉**模型，按图计费 | caption 端点最耗 token：每个资产一次视觉调用 |
| **B. 本机 Ollama（免费、离线、无限量）** | 不用给 key，**我可以直接装** | 磁盘：vision 模型 ~6.2 GB（`qwen3-vl:8b`）+ embedding 模型 ~0.6 GB（`qwen3-embedding:0.6b`） | key 填任意非空字符串即可（插件只塞进 `Authorization` 头，不校验）；**但要确认 Ollama 的 `response_format:{type:"json_schema"}` 被支持**，否则 caption 那条会失败 |
| **C. 国产云服务（便宜、中文可用）** | 1 个 key | 按量 | 阿里百炼 `text-embedding-v3` / `qwen3-embedding` 有 OpenAI 兼容端点；caption 需要**视觉**模型且支持 `json_schema` |

**只做检索不建索引**是不行的：`Search` **每次查询都要把 query 变成向量**，
所以即使索引已存在（`Saved/SemanticSearch/SearchIndex.bin`），查询阶段照样要 embedding 服务。
（`bAutoIndexCachedOnStartup=True` 只是让你不必重建索引。）

#### 各方案要填的具体字段

```
CaptioningBaseUrl  = https://api.openai.com/v1        # 或 http://127.0.0.1:11434/v1
CaptioningApiKey   = <你的 key>
CaptioningModel    = gpt-5.4-mini                    # 必须是能看图 + 支持 json_schema 的
EmbeddingBaseUrl   = https://api.openai.com/v1        # 或同上
EmbeddingApiKey    = <你的 key>
EmbeddingModel     = text-embedding-3-small
EmbeddingDimension = 512                             # 必须 = 服务端实际返回的向量长度
```

**通过 MCP 配置（不用手点 UI）**：

```js
// ConfigSettingsToolset 能读写这个 section
await callTool('call_tool', {
  toolset_name: 'ConfigSettingsToolset.ConfigSettingsToolset',
  tool_name: 'SetSectionProperties',
  arguments: {
    containerName: 'Editor', categoryName: 'Plugins', sectionName: 'Semantic Search',
    propertiesJson: JSON.stringify({ EmbeddingApiKey: 'sk-xxx', CaptioningApiKey: 'sk-xxx' }),
  },
});
await callTool('call_tool', {
  toolset_name: 'ConfigSettingsToolset.ConfigSettingsToolset',
  tool_name: 'SaveSection',
  arguments: { containerName: 'Editor', categoryName: 'Plugins', sectionName: 'Semantic Search' },
});
```

> ⚠️ **`SaveSection` 会写进工程的 `Config/DefaultEditorPerProjectUserSettings.ini`**（源控文件），
> key 会明文进版本库。**只在本地用 `SetSectionProperties`（不 Save）**，
> 或者用完立刻把 key 清空再 Save。实测确认：`SetSectionProperties` 只改内存（重启即失效），
> `SaveSection` 才落盘到工程 ini。
>
> 另外 key 是 `PasswordField`，但**插件的日志会把它打出来**：
> `LogSemanticSearch: OpenAIEmbeddingProvider created (..., EMBED API KEY MISSING)` —— 配好之后
> 这行日志变成没有 `KEY MISSING` 后缀，但仍会打 model/base url。

**建索引**：在 UE 控制台执行 `SemanticSearch.IndexAll`（会把 `IndexedPaths` 下的资产送去生成
caption + embedding）；`SemanticSearch.IndexStats` 看索引状态。
`IndexedPaths` 默认是 `/`（整个工程）。控制台命令**没有**对应的 MCP 工具，
需要用 UE 自生的 `ExecuteConsoleCommand`（Python）或者手工在 UE 控制台里敲。

> 💡 **不想开控制台也能建索引**：`bAutoIndexOnSave=True`（默认）时，
> **保存一个资产就会自动给它建索引**。用 MCP 触发就是
> `AssetTools.save_assets({asset_paths:['/Game/...']})`，等几秒后看日志出现
> `Successfully stored semantic data in DDC for: <资产路径>` 即成功。
> ⚠️ 资产**必须有缩略图**否则会 `Indexing failed … Thumbnail compressor is null`
> （重复/复制出来的资产常常没有缩略图；材质、静态网格一般都有）。

---

## 🟢 已验证的「零成本」方案：DeepSeek 做看图 + 本机做向量

**实测结论（2026-10-20，UE 5.8 + DeepSeek + 本机 llama.cpp）**：

| 需求 | DeepSeek 能不能干 | 实测结果 |
|---|---|---|
| 看图 caption | ✅ 能 | `deepseek-flash` 的 `input_modalities` 含 `image`；发 `image_url` 能正确描述图片 |
| `json_schema` 结构化输出 | ❌ **不能** | HTTP 400 `This response_format type is unavailable now`（只支持 `json_object`） |
| 向量 embedding | ❌ **完全没有** | `/embeddings`、`/v1/embeddings`、`/embed` 全部 HTTP 404 |

所以**不能直接换成 DeepSeek**：需要两处适配。本仓库已经把它做好了：

* `tools/semanticsearch-shim.py` —— 把 UE 硬编码的 `json_schema` 翻译成 `json_object`
  （把 schema 注入 system prompt，再校验/修复模型返回的 JSON），
  并把 `/embeddings` 转发到本机 embedding 服务。两个服务对外表现成**一个** OpenAI 端点。
* `tools/setup-semanticsearch.sh` —— 一键装 llama.cpp + 拉 Qwen3-Embedding-0.6B（~640 MB）
  + 启动 embedding 服务与 shim。

```bash
export SHIM_UPSTREAM_BASE=https://api.deepseek.com
export SHIM_UPSTREAM_KEY=sk-你的key        # 任何「支持看图 + json_object」的模型
./tools/setup-semanticsearch.sh
```

UE 里填（`Project Settings → Plugins → Semantic Search`）：

```
CaptioningBaseUrl   = http://127.0.0.1:8765/v1
CaptioningApiKey    = local          # 任意非空字符串，插件不校验
CaptioningModel     = deepseek-flash
EmbeddingBaseUrl    = http://127.0.0.1:8765/v1
EmbeddingApiKey     = local
EmbeddingModel      = qwen3-embedding
EmbeddingDimension  = 1024           # 必须 = 本机服务真实返回的向量长度
```

**本机侧已实测跑通**：`llama-server --embedding` + Qwen3-Embedding-0.6B → 1024 维；
`Search('sphere')` 返回按语义排序的命中（`Sphere` / `EditorCube` / `M_SemTest` / `MatineeCam_SM`），
每条都带 DeepSeek 生成的 caption；`FindSimilar(EditorCube)` 也能返回相似资产。

### ⚠️ 两个会踩的坑

1. **`EmbeddingDimension` 必须在编辑器启动前定好。**
   运行中改维度 → UE 用旧维度的索引查新维度的向量 →
   `FlatVectorIndex.cpp` 的 `check(QueryVector.Num() == Dimension)` 断言 → **编辑器直接崩**。
   改完请删掉 `<Project>/Saved/SemanticSearch/SearchIndex.bin` 再重启编辑器。
2. **llama.cpp 会忽略请求里的 `dimensions`**，返回它模型自己的长度。
   所以 `EmbeddingDimension` 必须填**服务端真实长度**（Qwen3-Embedding-0.6B = 1024），
   而不是抄 OpenAI 的 512。填错就是上面那个崩溃。
| `GameFeaturesToolset.IsGameFeatureActive` / `GetGameFeatureState` | 本工程没启用任何 Game Feature Plugin | `ListDiscoveredGameFeaturePlugins` 返回 `[]`，报 `GFP not found: <name>` |
| `NiagaraToolset_System.ApplyStackIssueFix` | 该 issue 的 `fixes` 数组为空，没有可应用的修复项 | `GetStackIssues` 看 `fixes` 是否为 `[]` |
| `UMGToolSet.SetNamedSlotContent` | 宿主控件必须实现 `INamedSlotInterface` | 报 `HostWidget 'X' does not implement INamedSlotInterface.` |
| `SequencerOutlinerTools.get_outliner_children` / `is_node_expanded` | Outliner view model 只在面板内有效，且刚取到的节点也立刻失效 | 报 `SequencerModuleOutlinerScriptingObject: View Model is no longer valid.` |
| `SequencerImportExportTools.link_anim_sequence` | `binding.sequence` 要 `MovieSceneSequence` 对象，但 LevelSequence 的内部序列无法用软路径表示 | 报 `is not valid MovieSceneSequence for property 'Sequence'` |

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
