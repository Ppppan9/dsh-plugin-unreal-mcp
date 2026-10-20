# dsh-plugin-unreal-mcp

> 让 **DeepSeek Harness（DSH）** 直接驱动 **Unreal Editor 5.8+**。
> 通过逆向分析 Epic 官方为 Claude Code 发布的 Unreal MCP 插件制作而成。

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DeepSeek-Harness-4D6BFE.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![Unreal](https://img.shields.io/badge/Unreal-5.8%2B-0E1128.svg)](https://www.unrealengine.com/)
[![REA](https://img.shields.io/badge/reverse--engineered%20with-REA-ff6b6b.svg)](https://www.npmjs.com/package/rea-agents)

[English](#english) | 中文

---

## 这是什么

一个 **DSH bundle 插件**，装上之后 DSH 里的 agent 就能直接操控运行中的 Unreal Editor：
摆放 actor、改材质参数、搭 Blueprint / UMG / Niagara、跑 Live Coding 编译、执行自动化测试。

**引擎侧不需要写任何代码** —— 用的是 UE 5.8 自带的官方 `ModelContextProtocol` 插件（随引擎分发，闭源）。
本仓库只是它的**客户端 + 使用契约**。

---

## 来源说明（重要）

本项目**逆向自 Epic Games 官方为 Claude Code 发布的插件**
`unreal-engine-skills-for-claude-code`（MIT，commit `a6aa73a`）。

- **分析工具**：[REA](https://www.npmjs.com/package/rea-agents)（reverse-engineer-anything）6.4.0
- **分析对象**：Epic 官方 Claude Code 插件的完整源码树（995 行文本 + 84 行 bash hook），
  [github.com/EpicGames/unreal-engine-skills-for-claude-code-plugin](https://github.com/EpicGames/unreal-engine-skills-for-claude-code-plugin)
- **完整逆向报告**：[`docs/REPORT.md`](docs/REPORT.md)
  —— 含引擎侧 MCP 协议细节、真机实测数据、与第三方报告的差异对照

本仓库是**对 DSH 的原生等价实现**，不是 Claude Code 插件的移植壳子：

| Epic 原版做法 | 本项目做法 |
|---|---|
| Claude Code 的 `SessionStart` bash hook 注入项目上下文 | DSH 的 `systemPrompt.section()` 动态 section |
| 用 `.mcp.json` 静态配置 MCP 连接 | DSH 的 `cordis.patch.yml` 复用官方 `dsh-mcp-client` |
| 需要 `unreal_mcp_proxy`（stdio→HTTP 桥） | **不需要**（DSH 原生支持 Streamable HTTP） |
| Skill 文本按 Claude Code 语境写 | Skill 文本按 DSH 语境重写（工具名带 `mcp__unreal__` 前缀） |

引擎侧的 `ModelContextProtocol` 插件归 Epic Games，闭源、随引擎分发，**本仓库不含其任何代码**。

---

## 安装

### 1. 引擎侧（UE 5.8+）

在工程的 `.uproject` 里启用两个插件（缺一不可）：

```json
{
  "FileVersion": 3,
  "Plugins": [
    { "Name": "ModelContextProtocol", "Enabled": true },
    { "Name": "AllToolsets", "Enabled": true }
  ]
}
```

> `ModelContextProtocol` 是 server；`AllToolsets` 是**默认关闭**的工具集聚合器，
> 不开它 server 能起来但**一个工具都没有**。

让编辑器启动时自动开 MCP server，写入
`<Project>/Saved/Config/MacEditor/EditorPerProjectUserSettings.ini`：

```ini
[/Script/ModelContextProtocolEngine.ModelContextProtocolSettings]
bAutoStartServer=True
```

或者每次在编辑器控制台执行 `ModelContextProtocol.StartServer`。

### 2. DSH 侧

```bash
# 本地安装
dsh plugin --profile <你的 profile> add "link:/绝对路径/dsh-plugin-unreal-mcp"

# 或者发布到 npm 后
dsh plugin --profile <你的 profile> add dsh-plugin-unreal-mcp
```

`add` 会自动完成依赖安装和 bundle 选择，**不需要手工编辑 profile 配置**。
安装后**开一个新会话**即可。

想确认装对了：

```bash
dsh --profile <你的 profile> --dump-config | grep -A6 unreal-mcp
# 应出现 id: unreal-mcp-client 和 id: unreal-mcp 两行
```

端口不是默认 8000 的话，设 `UNREAL_MCP_PORT` 环境变量：

```bash
export UNREAL_MCP_PORT=8123   # 然后启动 DSH
```

---

## 用法

UE 默认开启 **Tool Search 模式**，所以 `tools/list` 里**只有 3 个元工具**，
几百个真工具靠 `call_tool` 在服务端派发：

| DSH 工具名 | 作用 |
|---|---|
| `mcp__unreal__list_toolsets` | 列出所有 toolset（返回**全限定名** + 描述） |
| `mcp__unreal__describe_toolset` | 读某个 toolset 的工具 schema |
| `mcp__unreal__call_tool` | 派发：`{toolset_name, tool_name, arguments}` |

三步契约是**必需品**：**发现 → 描述 → 派发**。

### 真机实测的几个坑

| 坑 | 正确做法 |
|---|---|
| `list_toolsets` 返回的是 **Markdown 列表**，不是 JSON | 不要 `JSON.parse`，按 `/^- ([^:\n]+): /` 解析 |
| `describe_toolset` 的 `tools[].name` 是全限定名 | `call_tool` 的 `tool_name` 要**剥掉 `<toolset_name>.` 前缀** |
| `TOptional` 参数省略报错 | **显式传 `null`** |
| 属性名猜错会让整次调用失败 | 先 `ObjectTools.list_properties` 拿真实属性名 |
| `ObjectTools` 的 `returnValue` 是**双层 JSON** | 要 parse 两次 |

更多细节见 `skills/unreal-mcp/SKILL.md`（agent 会自动加载它）。

### 三个 skill

| skill | 用途 |
|---|---|
| `unreal-mcp` | 主要入口：在活的编辑器里查/改东西 |
| `create-toolset` | 给自己项目新增 toolset（C++ / Python） |
| `unreal-skill` | 写项目级 Agent Skill |

---

## 验证状态

| 项 | 状态 |
|---|---|
| 真机 Unreal Editor 5.8 / macOS | ✅ 已验证 |
| MCP 线路契约（session 头、3 元工具） | ✅ |
| 真实只读调用 | ✅ `get_current_level`、`find_actors` |
| 真实写操作 | ✅ 创建/删除 actor、改属性 |
| 真实截图 | ✅ `CaptureViewport` |
| ActorTools | ✅ 变换读写、标签、组件列表、look_at |
| BlueprintTools | ✅ 创建蓝图、变量、函数+参数、DSL 节点图、编译、回读 |
| Blueprint DSL | ✅ `bind` / `if` / `for` / `fn` 可用；`switch` 不生成节点（已记录边界） |
| 蓝图 PIE 运行 | ✅ DSL 生成的图在 PIE 中真跑，日志 + 位置采样双重验证 |
| MaterialTools | ✅ 创建材质、加表达式、列表达式、重编译 |
| MaterialInstanceTools | ✅ 创建材质实例、参数读写 |
| UMGToolSet | ✅ 创建 Widget BP、加 TextBlock、控件树、编译 |
| SequencerTools | ✅ 创建 LevelSequence、播放范围、root folder、TransformTrack、binding/track/section/标记帧/选择/复制粘贴 |
| ProgrammaticToolset | ✅ Python 沙箱编排多工具；沙箱边界（白名单 6 模块、禁 `unreal`）已验证 |
| Niagara | ✅ 创建 System、全量读取栈/发射器/模块/渲染器、读写用户变量与栈数据、增删模块/渲染器/发射器 |
| PCGToolset | ✅ 建图、查结构/Schema、读节点与 pin、连/断边、改节点参数与注释 |
| Sequencer 全家 | ✅ 8 个 Sequencer/ControlRig toolset 共 319 个工具逐个验证（相机相关除外，见下） |
| UMGToolSet | ✅ 创建 Widget BP、控件树增删改、编译、事件绑定、变量切换 |
| MaterialTools 进阶 | ✅ 表达式增删连断、参数组增删改、输出连接、布局 |
| DataTable / CurveTable / StringTable / DataAsset | ✅ 建资产 + 增删改查行 + schema 读写 |
| 830 个工具全量扫描 | ✅ **830/830 可派发，FAIL = 0**；OK 433 / 契约验证 382 / 环境限制 9 / 有意未调 6 |
| SemanticSearch（向量检索） | ✅ **已跑通**：DeepSeek 看图 caption + 本机 llama.cpp 做向量，`Search` / `FindSimilar` 均返回语义排序结果（见 `tools/setup-semanticsearch.sh`） |
| 自动化测试 | ✅ 离线 128 断言 + 真机 21 断言 |
| 崩溃后恢复 | ✅ 定位并修复「Restore Packages 模态框阻塞 MCP」；两条崩溃路径（Sequencer Camera Cut / UMG WrapWidgets）已写进 skill |

一键复跑：

```bash
cd tests
./run-all.sh            # 不需要 UE，mock 套件
./verify-real-ue.sh     # 需要 UE 编辑器正在运行
```

**未验证**：Windows / Linux 平台、UE 5.5–5.7、8 个因环境限制不可用的工具
（GameFeatures 本工程无 GFP、Niagara `ApplyStackIssueFix` 无可修复项、
UMG `SetNamedSlotContent` 需 `INamedSlotInterface`、Sequencer Outliner 2 个需面板 view model、
Sequencer `link_anim_sequence` 需 `MovieSceneSequence` 对象）——每个都有可复现的原文错误，
清单见 [`docs/VERIFICATION.md`](docs/VERIFICATION.md) §6.7。
SemanticSearch 原本也在这张表里，现已用 `tools/setup-semanticsearch.sh` 跑通（§6.10）。

完整逐工具结论（830/830）见 [`docs/VERIFICATION.md`](docs/VERIFICATION.md)；
逆向推导过程见 [`docs/REPORT.md`](docs/REPORT.md)。

---

## 已知限制

**编辑器重启后需要手动重建连接。**

关掉编辑器再打开，DSH 里的 UE 工具会报
`Bad Request: no valid session ID provided`。根因：编辑器关闭时端口消失，
但 MCP 客户端收不到断线信号（无长连接可断 → `onclose` 不触发），不会自动重连。

**恢复**：Web 侧边栏 **Plugins** → `Unreal Engine MCP` → **关掉再打开**。
秒级，不需要重启 DSH。

这与「DSH 先启动、编辑器后启动」不同 —— 后者是正常首连，会自动接上。

---

## 目录结构

```
├── index.js                 Host 插件：skill provider + UE 工程探测
├── cordis.patch.yml         MCP 连接配置 + 本插件行
├── package.json             DSH bundle 清单
├── icon.svg
├── locale/{en,zh}.json
├── skills/                  3 个 skill（派生自 Epic MIT 插件）
├── LICENSE-Epic-Games-MIT.txt   Epic 原始 MIT 许可
├── NOTICE.md                派生物与改动清单
├── docs/
│   ├── REPORT.md            逆向报告：架构、真机实测、差异对照
│   └── SPEC.md              团队开发用事实规范
└── tests/                   不需要 UE 的验证工程
```

---

## 安全边界

| 面 | 事实 |
|---|---|
| 绑定 | 只绑 `127.0.0.1`，拒绝非 loopback `Origin` |
| 认证 | **无认证层**。同机同用户任意进程都能连 |
| 暴露 | Epic 明确「不适合暴露到本机之外」 |
| 破坏性 | 工具直接改 live UObject 状态，可能改/移/删 VCS 跟踪资产 |

**红线**：别在共享机器开这个 server；批量资产操作前后各 commit 一次。

---

## 许可

- 本仓库的 `index.js`、`tests/`、`docs/` 为原创，MIT
- `skills/` 下的三个 skill 派生自 **Epic Games** 的 MIT 许可插件
  [`unreal-engine-skills-for-claude-code-plugin`](https://github.com/EpicGames/unreal-engine-skills-for-claude-code-plugin)，
  原始文本见 [`LICENSE-Epic-Games-MIT.txt`](LICENSE-Epic-Games-MIT.txt)，
  改动清单见 [`NOTICE.md`](NOTICE.md)

---

<a id="english"></a>

# English

A **DeepSeek Harness bundle** that lets DSH agents drive a live **Unreal Editor 5.8+**.

**Reverse-engineered from** Epic Games' official Claude Code plugin
[`unreal-engine-skills-for-claude-code`](https://github.com/EpicGames/unreal-engine-skills-for-claude-code-plugin) (MIT, `a6aa73a`) using
[REA](https://www.npmjs.com/package/rea-agents) 6.4.0. Full reverse-engineering report:
[`docs/REPORT.md`](docs/REPORT.md).

## Install

Engine side (`.uproject`):

```json
{ "Name": "ModelContextProtocol", "Enabled": true },
{ "Name": "AllToolsets", "Enabled": true }
```

Auto-start the server via `Saved/Config/MacEditor/EditorPerProjectUserSettings.ini`:

```ini
[/Script/ModelContextProtocolEngine.ModelContextProtocolSettings]
bAutoStartServer=True
```

DSH side:

```bash
dsh plugin --profile <profile> add "link:/absolute/path/to/dsh-plugin-unreal-mcp"
```

## Usage

UE defaults to Tool Search mode, so only three meta-tools are exposed:
`mcp__unreal__list_toolsets`, `mcp__unreal__describe_toolset`, `mcp__unreal__call_tool`.
Real tools are dispatched server-side through `call_tool`.

Gotchas (verified on a real engine):

- `list_toolsets` returns **Markdown**, not JSON — don't `JSON.parse` it
- `call_tool`'s `tool_name` needs the `<toolset_name>.` prefix **stripped**
- `TOptional` params must be passed as explicit `null`
- One wrong property name fails the whole `get_properties` call — use `list_properties` first
- `ObjectTools` returns are **double-encoded** JSON — parse twice

## Known limitation

Restarting the editor breaks the MCP session. Tools will fail with
`Bad Request: no valid session ID provided`. Fix: toggle the
`Unreal Engine MCP` plugin off and on in the DSH Plugins page.

## License

MIT. `skills/` derives from Epic Games' MIT-licensed plugin — see
[`NOTICE.md`](NOTICE.md).
