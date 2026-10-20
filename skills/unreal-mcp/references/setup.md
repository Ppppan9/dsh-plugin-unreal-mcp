# 首次配置（DSH × Unreal MCP）

这份文档只讲**编辑器侧**要做什么。DSH 侧的连接已经由 `dsh-unreal-mcp` bundle 配好了。

## 分工：谁配什么

| 侧 | 谁负责 | 要做什么 |
|---|---|---|
| UE 编辑器 | 用户 | 启用两个插件、起 server（手动或自启动）、确认端口 |
| DSH | **本 bundle** | 已在 `cordis.patch.yml` 里加了 `@deepseek-ai/dsh-mcp-client`，`serverName: unreal`，`url: http://127.0.0.1:8000/mcp` |

**不需要生成 `.mcp.json`。** 那是 Claude Code 的配置文件格式；DSH 的 MCP 配置就是 profile 里的
`cordis.patch.yml`，bundle 安装时就写好了。编辑器的
`ModelContextProtocol.GenerateClientConfig ClaudeCode` 命令对 DSH **没有用**，不要跑。

**不需要安装 `unreal_mcp_proxy`。** 见 `SKILL.md` 末尾那一节：DSH 原生支持 Streamable HTTP，
proxy 是给只认 stdio 的宿主用的。

## 1. 在 `.uproject` 里启用两个插件

两个插件都要，缺一不可：

- `ModelContextProtocol` —— server 与传输层。
- `AllToolsets` —— 提供全部工具。**只启用 `ModelContextProtocol` 的话，server 起来了但一个工具都没有。**

打开工程的 `.uproject`，在 `Plugins` 数组里确保：

```json
{
  "Name": "ModelContextProtocol",
  "Enabled": true
},
{
  "Name": "AllToolsets",
  "Enabled": true
}
```

数组不存在就新建。某项存在但是 `"Enabled": false` 就改成 `true`。

`AllToolsets` 是 editor-only 的聚合插件，`EnabledByDefault` 是关的，必须显式开。
只想暴露部分工具时，改为启用具体的 toolset 插件（`EditorToolset`、`NiagaraToolsets` 等），
不要用 `AllToolsets`。

**改 `.uproject` 前先跟用户确认文件路径，不要静默改。**

## 2. 起 server

默认行为是**不自动启动**。两种做法：

### 手动（会话内随时可用）

在编辑器控制台（`` ` `` 键）里：

```text
ModelContextProtocol.StartServer
```

换端口：

```text
ModelContextProtocol.StartServer 8001
```

### 自动（每次开编辑器就起）

把下面这段写进**每用户**的编辑器配置：

```text
<Project>/Saved/Config/<Platform>Editor/EditorPerProjectUserSettings.ini
```

```ini
[/Script/ModelContextProtocolEngine.ModelContextProtocolSettings]
bAutoStartServer=True
```

可选的覆盖项（默认值和别的本地服务冲突时才需要）：

```ini
ServerPortNumber=8000
ServerUrlPath=/mcp
```

这是编辑器自己会写的文件（你在 Editor Preferences 里勾选时它就写这里），**每用户、不进版本控制**。

命令行替代方案：给编辑器传 `-ModelContextProtocolStartServer`（可再加
`-ModelContextProtocolPort=<port>`）。**优先用 `.ini`**，它是持久的。

### 端口解析优先级

命令行 `-ModelContextProtocolPort=N` → 设置 CDO → **默认 8000**。

## 3. 如果换了端口，DSH 侧怎么跟

bundle 的 patch 里写的是：

```yaml
url: !!js 'process.env.UNREAL_MCP_PORT ? "http://127.0.0.1:" + process.env.UNREAL_MCP_PORT + "/mcp" : "http://127.0.0.1:8000/mcp"'
```

所以只要在**启动 DSH 之前**设置环境变量：

```bash
export UNREAL_MCP_PORT=8001
```

URL 路径 `/mcp` 是固定的；`ServerUrlPath` 改过的话，需要改 profile 里的 `url`（不要改本 bundle 的
源文件，改 profile 自己的 `cordis.patch.yml` 覆盖那一行）。

## 4. 验证

按顺序，每步都要过：

1. 编辑器 Output Log 里有 MCP server 启动的日志（类别 `LogModelContextProtocol`）。
2. DSH 里调 `mcp__unreal__list_toolsets` —— 能返回 toolset 列表就说明整条链路通了。
   结果在 `content[0].text` 里，是一段 JSON 字符串，要 `JSON.parse`。
3. 再调一次只读工具确认真的能执行，例如 `mcp__unreal__call_tool` →
   `toolset_name: "editor_toolset.toolsets.scene.SceneTools"`、`tool_name: "get_current_level"`。

**「工具在列表里」不等于「编辑器可达」**：DSH 的 mcp-client 在编辑器没开时会走重连退避，
重连成功前注册的工具可能是空的。工具数量为 0 或者全部调用失败，按 `operations.md` 的排障矩阵走。

## 5. 常见配置错误

| 现象 | 原因 |
|---|---|
| `list_toolsets` 返回空数组 | 只启用了 `ModelContextProtocol`，没启用 `AllToolsets`（或具体 toolset 插件） |
| DSH 里一个 `mcp__unreal__*` 工具都没有 | 编辑器没开，或者 server 没起，或者端口不是 8000 而环境变量没设 |
| 工具全都在但一调就失败 | server 起着但编辑器在忙 / 处于 PIE / 插件刚被 `RefreshTools` 重置 |
| 换端口后 DSH 连不上 | 忘了设 `UNREAL_MCP_PORT`，或者改了 `ServerUrlPath` 但没改 profile |
