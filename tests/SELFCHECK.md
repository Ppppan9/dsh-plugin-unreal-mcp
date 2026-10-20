# 测试框架自检（fixture 版本）

> ⚠️ **本文档记录的是「测试框架本身可用」的证据，与交付物的验证结果无关。**
> 交付物的真实验证结果请见 `REPORT.md`（Lead 维护）与 `run-all.sh` 的实时输出。
> 二者请勿混读：这里的 114 断言来自 /tmp 下的**替代 fixture**，不是 `plugin/`。

## 为什么要做这次自检

`plugin/` 由另一位成员（bundle-author）并行产出。测试工程不能等它落地才开始验证——
否则一旦测试自身有 bug（断言写错、helper 签名不对、进程管理泄漏），
就会和交付物的 bug 混在一起，无法区分是「测试写错了」还是「插件写错了」。

因此先用一份**最小的替代 fixture**（结构同 SPEC.md §3 的 plugin/）跑通三份测试，
确认框架本身可靠；等真 `plugin/` 落地后再跑一遍，两次结果分别记录。

## 自检环境

| 项 | 值 |
|---|---|
| 时间 | 2026-10-20 01:40:31 CST |
| 运行时 | `/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness` |
| Node 版本 | v24.21.0 |
| fixture 位置 | `/tmp/ue-selftest/plugin`（临时目录，现已清理） |
| fixture 组成 | package.json / cordis.patch.yml / index.js / 3×SKILL.md / references×2 / locale×2 / icon.svg / LICENSE / NOTICE（13 文件） |

## 自检结果（fixture 版本）

补充说明：52 与 61、24 与 27 的差异来自**自检之后新增的断言**（真 SDK 的 `!!js` 解析、零依赖检查、
skills 缺失降级、慢响应 timeout、返回形状），不是测试被削弱 —— 真交付物版本的断言数是**超集**。

```
wire-contract: 38 passed, 0 failed
plugin-unit:   52 passed, 0 failed   （早期版本；真交付物版本为 61，因新增了!!js/零依赖/降级等断言）
integration:   24 passed, 0 failed   （早期版本；真交付物版本为 27，因新增了慢响应 timeout 与返回形状断言）
──────────────────────────────────────────
断言总计: 114 passed, 0 failed
测试文件: 3/3 通过
```

## 自检暴露出的、已修正的测试自身 bug

自检的价值正在于它先抓到了这些**测试代码**的问题（而不是交付物的问题）：

| # | 问题 | 修正 |
|---|---|---|
| 1 | `includes()` helper 只支持字符串，传数组永远失败 | 改为同时支持 `String.includes` 与 `Array.includes` |
| 2 | 断言 `protocolVersion === '2025-06-18'`，但真 SDK 默认请求 `2025-11-25` | 改为断言「服务端降级后版本在支持列表内」，并打印实际协商值 |
| 3 | 断言「所有 post-init 请求都带 session 头」时把自己的**负例探测**也算进去了 | 按 `note` 字段排除负例（`missing/invalid session header`、`origin rejected`） |
| 4 | 断言 MCP `isError` 会以返回值形式出现 | 改为断言**抛异常**（源码：`if (result.isError === true) throw new Error(text)`） |
| 5 | 断言 `resourceBase` 是字符串 | 改为 dsh-skill 的闭集类型 `{kind:'directory', path}` |
| 6 | 用裸 `yaml` 包解析 patch，遇 `!!js` 只报警告并当成字符串 | 改用 DSH loader 的真方言：`js-yaml` 的 `JSON_SCHEMA.extend(JsExpr)`，并显式求值 `!!js` 节点 |

第 4、5、6 条不是「测试技巧」而是**关于交付物的行为事实**，已分别写进对应测试的注释与断言里：

- `built-in MCP isError → 抛异常`：agent 侧看到的是**工具调用失败**，不是字段；
- `resourceBase` 必须是 `{kind:'directory',path}`：bundled skill 的 references/ 靠它解析相对路径；
- `!!js` 是 DSH 的合法 YAML 方言：`url` 用表达式读取 `UNREAL_MCP_PORT`，解析器必须支持而不是当字符串。

## 真交付物的后续验证

fixture 自检通过后，真 `plugin/` 落地，同一套测试（加了上述修正）再次运行，结果见 `REPORT.md`。
