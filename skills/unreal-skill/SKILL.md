---
name: unreal-skill
description: 'Author, edit, or review an Unreal Engine Agent Skill: a named bundle of instructions registered with the Unreal MCP server and loaded by the in-editor agent, distinct from DSH harness skills under .dsh/skills or .agents/skills. Trigger when the user wants to add or change a skill the in-editor agent will load: create a new Agent Skill, add a skill for X workflow, edit or update this skill, review my skill, make a Python skill class, create a skill UAsset, register a skill so the agent picks it up; writing a SKILL.md inside a UE plugin Skills folder or Python skills folder; defining a Python skill class registered with the skill registry; calling CreateSkill, ListSkills, or GetSkills through the MCP server; designing a skill name, description, or instruction body. Skip for authoring a toolset (use create-toolset), invoking an existing skill at runtime (use unreal-mcp), editing DSH harness skills, or generic uses of the word skill.'
---

# Unreal Skill

你在写一个 **Unreal Engine Agent Skill**：命名好的、可复用的指令包，装着 agent 本来不知道、
或者需要特别注意的知识。一个 skill 可以给某个领域的通用最佳实践，也可以是某个具体工作流的指引，
或者两者混合。

> **先分清两种 skill，别搞混：**
> - **Unreal Agent Skill**（本 skill 讲的）：注册在 **Unreal MCP server 里**，由**编辑器内的 agent**
>   通过 `AgentSkillToolset` 加载。放在插件目录或 Content Browser 里。
> - **DSH harness skill**（不是这个）：注册在**DeepSeek Harness 里**，就是
>   `<project>/.dsh/skills/`、`<project>/.agents/skills/`、`~/.dsh/skills/` 下的 `SKILL.md`，
>   由 DSH 的 skill 工具加载。那是另一套机制，不要混进来。
>
> 用户说「加个 skill」时，先问清是给**编辑器内 agent** 还是给 **DSH**。判断线索：提到
> `CreateSkill`、`ListSkills`、`GetSkills`、Python skill 类、Content Browser、插件目录 → Unreal Agent Skill。

## 原则

一个好的 skill 是：

**新颖**：内容应该是 agent 不知道、或者用工具学不到的东西。agent 调个工具就能搞清楚的，别写进 skill。

**同侪口吻**：像给一个懂行的同事做简报，不是写文档。假设读者已经懂 Unreal。
给他能行动的东西，不是把每件事都解释一遍。

**灵活**：可以有概念解释、分步指令，或者混合。哪种形式对当前任务最清晰就用哪种。

**耐久**：不要把属性名、工具名这类会变的东西写死。引用了具体 API 名的 skill 会在那些名字变化时
**静默坏掉**。

**与编排无关**：不要引用编排系统、角色名、模型名，或者 agent 是怎么接起来的。
skill 应该在任何周边基础设施下都能用。

**节俭**：每个 token 都是成本。把 token 花在最重要、最长久的地方，砍掉不必要和不常青的内容。
如果删掉一句话读者不会若有所失，就删。

## 动手之前

**1. 这个 skill 已经存在了吗？** 通过 MCP 调 `ListSkills`（`mcp__unreal__call_tool`，
`toolset_name: "ToolsetRegistry.AgentSkillToolset"`、`tool_name: "ListSkills"`；
结果在 `content[0].text` 里，是一段 JSON 字符串，要 parse）看看工程里注册了哪些 skill，
然后对相关的调 `GetSkills`。能力已被覆盖就指向现有 skill，不要新建。

**2. 选实现路径。** 两条路，取决于 skill 住在哪：

- **Python 类**：skill 属于某个 code plugin 时的正确选择。它和插件的 Python toolset 放在一起，
  跟插件一起进版本控制，插件加载时自动注册。
- **UAsset**：skill 是工程专属、不该进插件时的正确选择。通过 MCP 的 `CreateSkill` 直接在
  Content Browser 里创建，不需要写代码。

## 结构

每个 Unreal skill 有两个字段：

**Description**：发现阶段就会加载，在 skill 的完整指令被读之前。一两句话，
清楚说明这个 skill 覆盖什么、什么时候适用。

**Instructions**：skill 的载荷。skill 激活后 agent 实际遵循的指引。
套用上面的原则：重点写工具教不了的东西，砍掉不必要的一切。

agent 在运行时通过 unreal-mcp 的元工具（`list_toolsets` / `describe_toolset` / `call_tool`；
DSH 里带前缀，是 `mcp__unreal__list_toolsets` 等）发现和派发工具。**所以写指令时要假设 agent 会自己去找
它需要的工具，不要在 skill 里固定列出 toolset 清单。**

## Python Skill

Python skill 是一个定义在插件里的 Python 文件中的 `UAgentSkill` 子类。
skill 属于某个 code plugin、应该跟插件一起进版本控制时用这条路径。

### 编写

类用 `@agent_skill` 装饰，继承 `unreal.AgentSkill`。上面「结构」里的两个字段对应类属性：

- 类 docstring 变成 **Description**。保持一两句话。
- `instructions` 是类属性字符串，装 skill 激活时加载的指引。

```python
import unreal

from toolset_registry.agent_skill import agent_skill

_INSTRUCTIONS = (
    'Do X before Y, because Z.\n'
    'Always verify the result after performing the operation.\n'
)

@agent_skill
class MySkill(unreal.AgentSkill):
    """Provides guidance on doing X in Unreal Engine.
    Apply this skill whenever the user wants to accomplish X."""

    instructions = _INSTRUCTIONS
```

### 注册

skill 在 import 时自己注册。没有特别理由的话，把 skill 文件放在插件的 Python 包下的 `skills/` 子目录里，
在那个子目录的 `__init__.py` 里逐个显式 import，并确保 `init_unreal.py` import 了 `skills` 包。

### 重载

改完 Python skill 之后，验证前先重载插件的包。**编辑器不会自己拾取改动。**
打开 **Edit → Project Settings → Plugins → Python → Enable Remote Execution**，然后：

```bash
python Engine/Plugins/Experimental/ToolsetRegistry/Content/Python/toolset_registry/tests/reload_remote.py your_plugin
```

## UAsset Skill

UAsset skill 是一个存成 Content Browser 资产的 `UAgentSkill` 实例。
skill 是工程专属、不该进插件、也不需要写代码时用这条路径。

### 编写

通过 MCP 用 `AgentSkillToolset`。先 `ListSkills` 看有什么，然后创建或更新：

**创建**：`call_tool` 派发 `CreateSkill`：
- `FolderPath`：Content Browser 目录，例如 `/Game/Skills/`
- `AssetName`：PascalCase 名，例如 `MyWorkflowSkill`
- `Description`：一两句话（见上面「结构」）
- `Details`：一个 `FAgentSkillDetails`，带 `Instructions`

**更新**：`call_tool` 派发 `UpdateSkill`：
- `SkillPath`：skill 的完整路径，例如 `/Game/Skills/MyWorkflowSkill.MyWorkflowSkill_C`
- `Description`：改后的描述
- `Details`：改后的 `FAgentSkillDetails`

（`CreateSkill` / `UpdateSkill` 的参数都是 UE 侧的对象 / 结构体，对象引用统一是
`{"refPath": "<soft object path>"}`；`TOptional` 参数必须显式传 `null`。见 `unreal-mcp` skill。）

## 审查你的产出

交付前调 `GetSkills` 确认 skill 长对了，然后**把 description 和 instructions 连起来读一遍，
按 agent 看到它们的方式读**：

- **Description**：清楚说明什么时候适用吗？只读 description 的 agent 能否判断某任务要不要激活它？
- **Instructions**：教了 agent 从工具学不到的东西吗？够简短到值这个 context 成本吗？
