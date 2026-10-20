---
name: create-toolset
description: 'Author or extend an Unreal Engine toolset: a class of static, AI-callable functions registered with ToolsetRegistry and exposed through the unreal-mcp server. Trigger when the user wants to add, expose, or register a new tool method, create a new toolset, or extend an existing one such as BlueprintTools, StaticMeshTools, ObjectTools, LevelTools, or MaterialTools. Concrete triggers: add a tool to X, expose this via MCP, register a function so the agent can call it, wire this into the toolset registry, create a new toolset for Y, add a Python toolset, make this AI-callable; adding a static method to a Tools.cpp, Tools.h, or tools .py file; editing files under a Toolsets folder; designing tool parameters, return types, or struct schemas. Skip for invoking existing tools at runtime (use unreal-mcp), authoring an Agent Skill (use unreal-skill), generic refactors that touch a toolset file without adding or redesigning a tool, or unrelated uses of the word toolset.'
---

# Create Toolset

你在写或扩展一个 Unreal Engine toolset：一组注册进 `ToolsetRegistry`、通过 MCP server 暴露给 agent 的
静态可调用函数。目标是扩大 agent 在编辑器里能做的事。

## 原则

- **干净**：设计出「能把这件事做成的」最简单 API。不要照抄 Unreal 现有 API，它们常常不必要地复杂。
  判据：一个技术美术不看实现能看懂吗？
- **完整**：支持 CRUD 对称。能 set 就应该能 get；有 create 就应该有 delete。
  不能/不该变更时，只有 getter 也完全可以。
- **可组合**：同类操作用同一套类型。`get_graph()` 返回 `Graph`，那 `get_graph_nodes()` 就该接收 `Graph`。
  函数应该能自然拼起来做更复杂的事。
- **DRY**：一个 toolset 内部不重复，跨 toolset 也不重复。`ObjectTools` 已经提供通用 UObject 属性读写，
  不要重造。功能在别处就调它，或者指过去。

## 动手之前

按顺序问自己：

**1. 这个功能已经有了吗？** 编辑器在跑的话，`mcp__unreal__list_toolsets` →
  `mcp__unreal__describe_toolset`（结果都在 `content[0].text` 里，是 JSON 字符串，要 parse）。
  MCP 不可用就在代码库里搜 `Toolsets` 目录，读 C++ 头文件或 Python toolset 文件。
  已经暴露了就什么都没得做 —— 告诉用户，指向正确的工具。

**2. 这个需求比听起来更泛吗？** 用户常提一个领域专属的需求，其实是某个更宽模式的实例。
  先问：这个能力真属于那个领域，还是普遍适用？比如「读 Blueprint 资产元数据」听起来该进
  `BlueprintTools`，但元数据对所有资产都适用，正确位置是 `AssetTools`。**通用解几乎总比窄解好。**

**3. 这个领域已经有 toolset 了吗？** 功能缺但领域已有 toolset（比如往 `StaticMeshTools` 加网格查询），
  就加到那里，别新建。

**4. 新 toolset 需要自己的插件吗？** 和现有插件关系紧密就放进去；领域足够独立才值得开新插件。
  不明显就问用户。

**5. 选实现语言。** 这是用户的决定，但要帮他做知情选择。**一般优先 Python**：迭代快、好改。

- **Python**：先看 Python stub 里有什么（`<project_root>/Intermediate/PythonStub/unreal.py`；
  **搜，不要整份读**）。文件不存在说明用户需要打开 **Edit → Project Settings → Plugins → Python** 里的
  **Developer Mode** 并重启编辑器 —— 做任何 toolset 工作都值得先开。需要的 API 都在，就选 Python。
  大部分在、少一点缺，把缺口告诉用户；有时一处小的引擎改动仍比弃用 Python 划算。
- **C++**：Python 覆盖很少或没有时的正确选择。大多数情况下你要的东西根本不在 stub 里。

先把两种语言各自能提供什么总结给用户，让他决定再动笔。**需要的 API 两边都没有时不要绕路 —— 停下来
告诉用户去扩展引擎。** Workaround 会做出静默坏掉的脆弱工具。

## 通用约定（C++ / Python 都适用）

- **不要重复已有工具。** 例如 `ObjectTools` 已经管通用 UObject 属性读写。
- **文档是硬要求。** 每个 toolset、每个 tool call 都必须有文档，见下面「文档」。
- **用真实的类型。** 参数和返回值要是实际类型（`int32`、`FVector`、`TArray<FString>`、struct……），
  registry 会自动序列化。在工具内部把结构化数据转成 / 转自 JSON 字符串是坏味道；
  类型是 string 就应该真的语义上是 string。
- **返回值带数据，不带状态。** 正常返回就是成功；失败就抛。不要用 bool、错误字符串、
  结果包装对象来表达错误。**抛异常。**
- **所有工具方法都是 static**，没有实例状态。
- **测试是硬要求。** 每个工具都要有覆盖，见下面「测试」。

## 文档

好的文档在每一层都是硬要求，不是可选打磨。**别写太细，短而准胜过长而全。**
一句话如果不能比代码本身多提供信息，删掉。

**Toolset 类**：1-3 句说清它做什么、覆盖哪个领域。模型常常只看到 toolset 名和这段描述，
从不加载它的工具，所以它必须能独立成立。描述领域和支持的操作种类，不要罗列工具名。

**每个工具**：说清做什么，每个参数都写，返回值也写。重点写**含义和单位**。

每一行的检验标准：**一个称职的读者能只从签名、名字、类型推出来吗？能就删。**
LLM 天生爱过度文档化，顶住。一行文档只有说出「代码说不出来的东西」才配存在。所以要删：
签名复述（类型、默认值、可选性）、用法和串联叙述（工具怎么组合签名里都写着）、
显而易见的示例、对字段「可能是啥」的猜测而不是「是啥」。

**写代码做了什么，不要写你为什么这么写。**「直接遍历子类是因为资产注册表会漏掉未加载的类型」
是实现理由，不是契约。说工具做什么；把理由删掉。

要保留的是推不出来的东西：单位、取值范围、非显然的编码（例如「单个空格分隔的字符串」）、
空结果 / null 结果意味着什么、名字没承载的领域含义。

```cpp
// 过度文档化：每一行都在复述签名或叙述用法。
/**
 * Runs a cheat. @param CheatName The cheat name (case-insensitive), pass it to run the cheat.
 * @param Args Optional arguments; fill in the slots from the Args hint (e.g. "<float F>" -> "2.0",
 *             "<float A> <float B>" -> "1 2"). Empty string for no arguments.
 */
// 削减后：只留推不出来的事实。
/**
 * Runs a cheat on the local player, as if typed into the console.
 * @param CheatName The cheat command name.
 * @param Args Arguments as a single space-separated string. Empty for none.
 */
```

**Struct**：struct 本身写清「代表什么、什么时候用」，每个字段写含义和单位。
`UPROPERTY` 的元数据（`ClampMin` / `ClampMax` 等）会被自动提取进 schema，用它来约束，
不要在注释里重复一遍。

## C++ 实现

### 结构

- 继承 `UToolsetDefinition`（来自 `ToolsetRegistry/ToolsetDefinition.h`）。
- 一个 toolset 类一个 `.h` / `.cpp`。
- 所有 AI 可调用的工具都是 **static 方法**，标 `UFUNCTION(meta = (AICallable))`。
  函数的文档注释会变成 AI 看到的 tool description，认真写。
- 私有 helper 是 static 方法但**不加** `UFUNCTION(meta = (AICallable))`，不加就不会暴露。
  要排除某个函数可以显式标 `meta = (AIIgnore)`。

```cpp
/**
 * Snapshot of a MyThing's current state, returned by GetThingInfo.
 */
USTRUCT(BlueprintType)
struct FMyThingInfo
{
    GENERATED_BODY()

    /** How thing-like this thing is. */
    UPROPERTY(meta=(ClampMin="0.0", ClampMax="1.0")) float Thinginess;

    /** Things that belong to this thing. */
    UPROPERTY() TArray<UMyThing*> SubThings;
};

/**
 * Manages MyThings in the current level. Covers the full lifecycle of these objects:
 * querying by name, reading their state, and performing operations on them.
 */
UCLASS(BlueprintType, MinimalAPI)
class UMyToolset : public UToolsetDefinition
{
    GENERATED_BODY()

public:
    /**
     * Returns all things whose name matches the given pattern.
     * @param NamePattern Substring to match against thing names.
     * @return Matching things, or an empty array if none are found.
     */
    UFUNCTION(meta = (AICallable), Category = "MyToolset")
    static TArray<UMyThing*> FindThings(const FString& NamePattern);

    /**
     * Returns detailed info about the given thing.
     * @param Thing The thing to read state from.
     * @return The thing's current state.
     */
    UFUNCTION(meta = (AICallable), Category = "MyToolset")
    static FMyThingInfo GetThingInfo(UMyThing* Thing);

    /**
     * Performs the primary operation on the given thing.
     * @param Thing The thing to perform the operation on.
     */
    UFUNCTION(meta = (AICallable), Category = "MyToolset")
    static void DoTheThing(UMyThing* Thing);
};
```

### 异步工具

大多数工具是同步的：在 game thread 上跑，直接返回值。截图、等编辑器状态变化这类长操作才用异步。

异步工具返回 `UToolCallAsyncResult` 的子类，而不是直接返回值。已有的结果类型很多，
也完全可以为任意值类型新造一个子类。**造之前先看现有类型。**

声明看上去和普通工具一样，只是返回类型换成异步结果：

```cpp
/**
 * Renders an image of the given thing.
 * @param Thing The thing to capture.
 * @return An image of the thing.
 */
UFUNCTION(meta = (AICallable), Category = "MyToolset")
static UToolCallAsyncResultImage* CaptureThingImage(UMyThing* Thing);
```

和同步工具不同，成功和失败**都**通过结果对象传达：成功调 `SetValue()`，失败调 `SetError()`。

```cpp
UToolCallAsyncResultImage* UMyToolset::CaptureThingImage(UMyThing* Thing)
{
    UToolCallAsyncResultImage* Result = NewObject<UToolCallAsyncResultImage>();

    if (!IsRenderingEnabled())
    {
        Result->SetError(TEXT("Rendering is not enabled."));
        return Result;
    }

    // 启动捕获；完成时调 Result->SetValue(image)。
    return Result;
}
```

正确的实现方式取决于你要动的那个系统。**写代码之前先看现有 toolset 里的真实例子。**

### 注册

Toolset 可以在任意时刻动态注册 / 注销。常见模式是在模块启动和关闭时做：

```cpp
class FMyToolsetModule : public IModuleInterface
{
    void StartupModule()
    {
        UToolsetRegistry::RegisterToolsetClass(UMyToolset::StaticClass());
    }

    void ShutdownModule()
    {
        UToolsetRegistry::UnregisterToolsetClass(UMyToolset::StaticClass());
    }
};
```

看同一个插件里附近的 toolset 用的是哪种模式。

### 自定义 Type-to-JSON 转换器

Registry 自动转换所有 Unreal 类型，你很少需要操心序列化。JSON 转换器让你对某个类型的表示
取得额外控制，通常是为了做出更干净、对 AI 更友好的 schema。

这是高级功能，**只在有明确需求时反应式地使用**，不要因为「可能有用」就上。
已有内置自定义转换器：

- **`FToolsetColorConverter`**：把 `FColor` 和 `FLinearColor` 统一成一种颜色表示，
  让 AI 不用理解 byte vs float 的区别。
- **`FToolsetReferenceConverter`**：把所有 `UObject*` / `UClass*` 属性转成带类型的 soft path 对象，
  而不是你本来会拿到的裸字符串。
- **`FToolsetTransformConverter`**：把 `FTransform` 的 location / rotation / scale 暴露成可选字段，
  比每次都要求三个分量的人体工学好得多。

需要覆盖的类型没被覆盖时，继承 `FToolsetJsonConverter`（来自 `ToolsetRegistry/ToolsetJsonConverter.h`），
和你的 toolset 一起注册。**写自己的之前，先读 ToolsetRegistry 插件源码里的现有转换器** ——
这个接口有好几个活动部件，现有实现是最好的指南。

### 错误处理

工具无法完成工作时（输入非法、资产缺失、前置条件不成立），抛脚本错误并立刻返回空 / 默认值：

```cpp
TArray<UMyThing*> UMyToolset::FindThings(const FString& NamePattern)
{
    if (NamePattern.IsEmpty())
    {
        UKismetSystemLibrary::RaiseScriptError(
            EScriptExceptionType::Error,
            TEXT("NamePattern must not be empty."));
        return {};
    }
}
```

## Python 实现

### 结构

- 类用 `@unreal.uclass()` 装饰，继承 `unreal.ToolsetDefinition`。
- 一个 toolset 类一个 `.py` 文件。
- AI 可调用的工具用 `@toolset_registry.tool_call` 加 `@staticmethod`，**装饰器顺序不能反**。
  docstring 会变成 AI 看到的 tool description。
- 私有 helper 是 `@staticmethod` 加 `_` 前缀，放在类末尾。
- **每个参数和返回值都必须有类型标注。** schema 生成完全依赖它。
- **用标准 Python 类型标注**（`list[str]`、`dict[str, str]`……），不要用 `unreal.Array[str]`
  这类 Unreal 等价物；`@toolset_registry.tool_call` 会自动转换。

```python
@unreal.uclass()
class MyToolset(unreal.ToolsetDefinition):
    """Manages MyThings in the current level. Covers the full lifecycle of these objects:
    querying by name, reading their state, and performing operations on them."""

    @toolset_registry.tool_call
    @staticmethod
    def find_things(name_pattern: str) -> list[MyThing]:
        """Returns all things whose name matches the given pattern.

        Args:
            name_pattern: Substring to match against thing names.

        Returns:
            Matching things, or an empty list if none are found.
        """
        ...

    @toolset_registry.tool_call
    @staticmethod
    def get_thing_info(thing: MyThing) -> MyThingInfo:
        """Returns detailed info about the given thing.

        Args:
            thing: The thing to read state from.

        Returns:
            The thing's current state.
        """
        ...

    @toolset_registry.tool_call
    @staticmethod
    def do_the_thing(thing: MyThing) -> None:
        """Performs the primary operation on the given thing.

        Args:
            thing: The thing to perform the operation on.
        """
        ...
```

### 注册

注册**从不自动**。把 toolset 类加进插件的注册列表，在初始化时
（通常是 `__init__.py` 或 `init_unreal.py`，和同插件其他 toolset 放在一起）调：

```python
def register_toolsets():
    unreal.ToolsetRegistry.register_toolset_class(MyToolset)

def unregister_toolsets():
    unreal.ToolsetRegistry.unregister_toolset_class(MyToolset)
```

在你正在改的插件里找到等价的函数，把 toolset 加进去。

### 错误处理

工具无法完成工作时直接抛异常：

```python
@toolset_registry.tool_call
@staticmethod
def find_things(name_pattern: str) -> list[MyThing]:
    """Returns things whose name matches the given pattern."""
    if not name_pattern:
        raise ValueError("name_pattern must not be empty.")
```

## 测试

测试是确认工具真的能用、并抓住后续变化引入的回归的唯一手段。**紧密循环**：写代码 →
需要就编译 → 跑测试 → 读失败 → 修 → 重复到全绿。

### 用活的编辑器（首选）

用 `unreal-mcp` 对着活编辑器跑测试是最快的迭代方式。改动可以编译或热重载而不用重启，结果立刻回来。
C++ 和 Python 都适用。

通过 MCP 跑测试（每一步都是 `mcp__unreal__call_tool`，结果在 `content[0].text` 里，要 parse）：

1. 加载 `AutomationTestToolset` 并调 **`DiscoverTests`**。**这是强制的第一步**，跳过会让后面全都返回空。
2. 调 `ListTests`，用你的 toolset 名过滤，确认测试被发现。
3. 调 `RunTests`，传完整测试路径。
4. 轮询 `GetTestStatus`，再调 `GetTestResults` 拿每个测试的详细错误和警告。

迭代 Python 测试时，重载之后调 `DiscoverTests` 要带 `force_rediscover=true`，
这样自动化系统才会看到新增 / 删除的测试。

### 命令行（没有运行中的编辑器）

没有编辑器时，命令行会起一个 headless 实例、跑指定测试、退出。因为有启动开销所以更慢（约 30 秒），
但不需要运行中的编辑器，适合 CI 或编辑器不可用时。

用 `UnrealEditor-Cmd` 加 `-ExecCmds` 直接调自动化测试系统：

```bash
UnrealEditor-Cmd.exe <Project>.uproject -ExecCmds="Automation RunTests AI.MyToolset;quit" -Unattended -NullRHI
```

把 `AI.MyToolset` 换成匹配你的 spec 名的测试过滤串。**看同一个插件里现有测试是怎么跑的**，
确认正确的 flag 和过滤前缀。

### 编译

```cpp
// 从运行中的编辑器重编译，不要切回 IDE：
//   call_tool { toolset_name: "LiveCodingToolset", tool_name: "CompileLiveCoding" }
// 它会阻塞到编译真正结束，并吐出 MSVC 诊断。有编译错误先修再往下走。
```

（`call_tool` 是慢的：它等 game thread 跑完。这是**正常**的，不要因为慢就重试。）

## 干完之后审一遍

代码写完、测试过了，退一步把整体读一遍再宣布完成。第一版常有「逐个工具看不出来」的问题：

- **重复的样板**：多个工具里反复出现的相似模式，能不能抽个 helper。
- **测试覆盖不全**：后加的抛错路径没测；成功用例只覆盖了一种场景。
- **重复的功能**：这个工具做的事，本 toolset 或别的 toolset 里已经做过了。
- **API 不一致**：参数名或类型和同 toolset 其他工具的约定不符。
- **文档缺口**：某个参数的描述写得含糊，或者类 docstring 不足以独立成立。
- **文档在复述代码**：这是最常见的失败 —— 重复类型 / 默认值 / 调用顺序的行，
  显然事情的示例，代码为什么长这样的理由。**逐行重读，删掉任何能从签名推出来的行。**

发现的问题在交付前改掉。干净的第二遍比之后的 bug 报告便宜。
