/**
 * dsh-plugin-unreal-mcp —— DSH Host 插件（纯 ESM，零第三方依赖）。
 *
 * 这个插件只做两件事，其余全部交给官方插件：
 *
 * 1. 注册 3 个 bundled skill（`unreal-mcp` / `create-toolset` / `unreal-skill`），
 *    内容直接从包内 `skills/` 读，不落盘到用户目录。DSH 的技能发现根里
 *    `<dshHome>/skills`、`bundledSkillDir` 都是固定目录，而我们要交付的是
 *    「一个可安装的包」，所以走 `ctx.skills.registerProvider` 这条包内注册通道。
 *
 * 2. 按 session 工作目录探测「这是不是一个 Unreal Engine 工程」，命中才往 system
 *    prompt 追加一句上下文。这是 Epic 官方 Claude Code 插件里 `SessionStart` hook
 *    的 DSH 等价物 —— DSH 没有 SessionStart hook，但有「每次 assembly 重新求值的
 *    prompt section」，语义更准确（换目录后下一轮就会重算）。
 *
 * MCP 连接不在这个文件里：它由 `cordis.patch.yml` 直接用官方的
 * `@deepseek-ai/dsh-mcp-client` 接上 UE 的 `127.0.0.1:8000/mcp`。
 * 不要在这里写 MCP 客户端、代理或桥接程序 —— 见 `skills/unreal-mcp/SKILL.md`。
 *
 * 依赖约束（实测结论，勿改）：
 * - profile 里安装的普通 JS 插件**无法 `import` `@deepseek-ai/*` 包**。profile 的
 *   node_modules 只包含该插件自己声明的依赖，Node 的 ESM 解析器从插件文件位置向上
 *   找不到 DSH 安装目录；DSH 的 two-anchor 解析只覆盖 cordis patch 里的 `name` 字段，
 *   不覆盖插件文件内部的 import 语句。
 *   → 所以这里只 import `node:` 内置模块，`BUNDLED_SKILL_RANK` 直接内联。
 * - `node:` 内置模块不受上面限制。
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Cordis 插件名（loader 诊断用）。 */
export const name = "unreal-mcp";

/**
 * 依赖的服务。
 *
 * 只声明 `skills`：它由 `@deepseek-ai/dsh-skill` 提供，是 base bundle 的固定行。
 * `systemPrompt` 故意**不**写在这里，而是在 apply 里用 `ctx.inject(['systemPrompt'], ...)`
 * 做可选依赖注入 —— 某些 profile（例如只跑子 agent 的精简组合）可能没有
 * system-prompt 服务，这时插件必须照常装载（skill provider 仍然有效），
 * 而不是卡在 pending。
 */
export const inject = ["skills"];

/** skill provider 名。必须与 candidate.provider 完全一致，注册表会校验。 */
const PROVIDER_NAME = "unreal-mcp";

/**
 * bundled skill 的标准 rank。
 *
 * 与 `@deepseek-ai/dsh-skill` 导出的 `BUNDLED_SKILL_RANK`（= 600）对齐，此处内联以
 * 避免 profile 插件的模块解析限制（见文件头）。数值语义：rank 越小优先级越高；
 * 600 是「随包分发 / 内置根」的标准档，低于项目级（100/200）、用户级（400/500）。
 */
const BUNDLED_SKILL_RANK = 600;

/** candidate.source 的取值。`bundled` 只表示来源标签，参与去重与展示。 */
const SKILL_SOURCE = "bundled";

/** 包内 skills 根目录（绝对路径）。 */
const SKILLS_DIR = fileURLToPath(new URL("./skills/", import.meta.url));

/**
 * 三个 bundled skill 的静态描述。
 *
 * 这里同时是**路由面**：模型在技能目录里只看到 name + description，
 * 描述写得准不准直接决定它会不会加载。因此描述不从 SKILL.md 的 frontmatter
 * 解析（不引入 YAML 依赖、不承担解析失败风险），而是在这里硬编码；
 * SKILL.md 的 frontmatter 供人读、也供用户把这三个目录拷进自己的 skill 根时使用。
 *
 * 三段描述均改写自 Epic Games 的 MIT 许可插件（见 NOTICE.md）：
 * 去掉 Claude Code 专属措辞（`/plugin`、`--dangerously-skip-permissions`），
 * 补上 DSH 侧的触发语（`.dsh/skills`、`.agents/skills` 的区分）。
 */
const SKILL_SPECS = [
	{
		name: "unreal-mcp",
		dir: "unreal-mcp",
		description:
			"Drive a live Unreal Editor through the MCP server named unreal: inspect and change the current level, actors, Blueprints, materials, Niagara, Sequencer, Control Rigs, behavior trees, gameplay ability state, UMG widgets, assets, and automation tests. Trigger when the user wants to change, query, or run something inside their Unreal Engine project, or asks to capture the viewport, select actors, inspect the content browser, or run an editor operation that has an MCP tool. Treat Unreal context as given even without the word Unreal when the request mentions .uproject, Content Browser, Outliner, PlayerStart, Live Coding, UE C++ types, or the asset prefixes BP_ WBP_ M_ MI_ NS_ CR_ SK_ SM_ ABP_. Skip for conceptual or documentation questions, and for Unity, Godot, or unrelated uses of blueprint, sequencer, or widget.",
	},
	{
		name: "create-toolset",
		dir: "create-toolset",
		description:
			"Author or extend an Unreal Engine toolset: a class of static, AI-callable functions registered with ToolsetRegistry and exposed through the unreal-mcp server. Trigger when the user wants to add, expose, or register a new tool method, create a new toolset, or extend an existing one such as BlueprintTools, StaticMeshTools, ObjectTools, LevelTools, or MaterialTools. Concrete triggers: add a tool to X, expose this via MCP, register a function so the agent can call it, wire this into the toolset registry, create a new toolset for Y, add a Python toolset, make this AI-callable; adding a static method to a Tools.cpp, Tools.h, or tools .py file; editing files under a Toolsets folder; designing tool parameters, return types, or struct schemas. Skip for invoking existing tools at runtime (use unreal-mcp), authoring an Agent Skill (use unreal-skill), generic refactors that touch a toolset file without adding or redesigning a tool, or unrelated uses of the word toolset.",
	},
	{
		name: "unreal-skill",
		dir: "unreal-skill",
		description:
			"Author, edit, or review an Unreal Engine Agent Skill: a named bundle of instructions registered with the Unreal MCP server and loaded by the in-editor agent, distinct from DSH harness skills under .dsh/skills or .agents/skills. Trigger when the user wants to add or change a skill the in-editor agent will load: create a new Agent Skill, add a skill for X workflow, edit or update this skill, review my skill, make a Python skill class, create a skill UAsset, register a skill so the agent picks it up; writing a SKILL.md inside a UE plugin Skills folder or Python skills folder; defining a Python skill class registered with the skill registry; calling CreateSkill, ListSkills, or GetSkills through the MCP server; designing a skill name, description, or instruction body. Skip for authoring a toolset (use create-toolset), invoking an existing skill at runtime (use unreal-mcp), editing DSH harness skills, or generic uses of the word skill.",
	},
];

/**
 * 从 SKILL.md 里剥掉 YAML frontmatter。
 *
 * provider 自己负责 body 的形状：DSH 的 filesystem provider 也是返回
 * `parsed.body.trim()`，所以包内 provider 必须做同样的事，否则模型会在
 * `<skill_instructions>` 里看到一段没用处的 frontmatter。正则容忍 CRLF；
 * 没有 frontmatter 时原样返回（trim 后）。
 */
const FRONTMATTER_PATTERN = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

/**
 * @param {string} text SKILL.md 原文。
 * @returns {string} 去掉 frontmatter 并 trim 后的正文。
 */
function stripFrontmatter(text) {
	return text.replace(FRONTMATTER_PATTERN, "").trim();
}

/**
 * 输出一条 warning，永不抛出。
 *
 * `list()` / `get()` 可能在插件卸载后被调用，或在没有 logger 的测试 ctx 里被调用；
 * 日志是诊断手段，不能成为失败源。
 * @param {object} ctx 插件上下文。
 * @param {string} message 日志正文。
 */
function warn(ctx, message) {
	try {
		ctx.logger?.warn?.(message);
	} catch {
		/* 日志不可用不影响功能 */
	}
}

/**
 * 构建候选项列表（每个进程只算一次）。
 *
 * 只有 `SKILL.md` 真实存在的 skill 才会被广告 —— 让「技能目录里列出的」
 * 与「`get()` 能加载的」永远一致；包损坏时宁可少一个技能，也不要广告一个空正文。
 *
 * @param {object} ctx 插件上下文（仅用于日志）。
 * @returns {ReadonlyArray<object>} DSH skill candidate 列表。
 */
function buildCandidates(ctx) {
	const candidates = [];
	for (const spec of SKILL_SPECS) {
		const directory = join(SKILLS_DIR, spec.dir);
		const file = join(directory, "SKILL.md");
		if (!existsSync(file)) {
			warn(ctx, `unreal-mcp: bundled skill "${spec.name}" is missing ${file}; it will not be advertised`);
			continue;
		}
		candidates.push({
			name: spec.name,
			description: spec.description,
			invocation: { modelInvocable: true, userInvocable: true },
			provider: PROVIDER_NAME,
			source: SKILL_SOURCE,
			rank: BUNDLED_SKILL_RANK,
			// locator 对注册表是不透明值，只回传给本 provider 的 get()；
			// 形状与 filesystem provider 的 locator 一致（path + directory），便于对照调试。
			locator: { path: file, directory },
			// resourceBase 会以「Base directory for this skill: <path>」出现在模型侧，
			// 是 `references/setup.md` 这类相对路径能被正确解析的前提。
			resourceBase: { kind: "directory", path: directory },
			path: file,
		});
	}
	return candidates;
}

/**
 * 加载一个 skill 的完整定义。
 *
 * 每次调用都重新读盘：注册表明确「definitions 从不缓存」，这样用户在开发时
 * 改 SKILL.md 立刻生效。文件缺失 / 读失败时返回 undefined（注册表会把它当作
 * 「技能已不可用」），绝不抛出 —— 一次 I/O 失败不该让整个技能目录不可用。
 *
 * @param {object} candidate 之前由 list() 返回的候选项。
 * @returns {object | undefined} skill definition。
 */
function loadDefinition(candidate) {
	const directory = candidate.locator?.directory;
	if (typeof directory !== "string") return undefined;
	try {
		const raw = readFileSync(join(directory, "SKILL.md"), "utf8");
		const content = stripFrontmatter(raw);
		if (content.length === 0) return undefined;
		return {
			name: candidate.name,
			description: candidate.description,
			invocation: candidate.invocation,
			provider: PROVIDER_NAME,
			source: SKILL_SOURCE,
			resourceBase: candidate.resourceBase,
			path: candidate.locator.path,
			content,
		};
	} catch {
		return undefined;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// UE 工程探测
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 顶层工程标记文件。
 *
 * 对应 Epic 官方 hook（`hooks/unreal-context.sh`）里的判定：
 * `GenerateProjectFiles.bat|.sh|.command` 或任一 `*.uproject`。
 */
const PROJECT_MARKERS = ["GenerateProjectFiles.bat", "GenerateProjectFiles.sh", "GenerateProjectFiles.command"];

/**
 * 判断一个目录本身就是不是一个 UE 工程根。
 *
 * 注意：**裸 `Engine/` 目录不算 marker**。UE 源码树里有 `Engine/Source/Runtime/Engine`，
 * 从 Runtime module 向上遍历会在 `Source/Runtime` 短路、把那里误判成工程根。
 * Epic 自己在 hook 源码的注释里专门警告过这个坑，这里必须保留同样的语义。
 *
 * 按 marker 顺序判定：命中 `GenerateProjectFiles.*` 的目录是引擎源码布局（`engine`），
 * 命中 `*.uproject` 的是普通游戏工程（`game`）。
 *
 * @param {string} directory 绝对目录。
 * @returns {{ root: string, kind: "engine" | "game", name: string } | null}
 */
function detectProjectRoot(directory) {
	try {
		for (const marker of PROJECT_MARKERS) {
			if (existsSync(join(directory, marker))) return { root: directory, kind: "engine", name: basename(directory) };
		}
		const entry = readdirSync(directory, { withFileTypes: true }).find(
			(candidate) => candidate.isFile() && candidate.name.endsWith(".uproject"),
		);
		if (entry !== undefined) return { root: directory, kind: "game", name: entry.name.replace(/\.uproject$/, "") };
	} catch {
		/* 权限 / IO 错误一律视为未命中，绝不抛出 */
	}
	return null;
}

/**
 * 从给定目录向上遍历，找最近的 UE 工程根。
 *
 * 为什么不用 DSH 自己的 projectRoot：DSH 的项目根是「最近的 `.git` 祖先」，
 * 而 UE 工程经常根本不在 git 里（或者 git 根在工程根的上一层）。所以这里
 * 必须自己向上走 —— 这也是为什么我们没有把 skill 放进 `.dsh/skills` 让
 * filesystem provider 自动发现，而是在 index.js 里注册 bundled provider。
 *
 * @param {string} from 起始绝对目录。
 * @returns {{ root: string, kind: "engine" | "game", name: string } | null}
 */
function findProjectRoot(from) {
	let directory = from;
	while (directory && directory !== dirname(directory)) {
		const hit = detectProjectRoot(directory);
		if (hit !== null) return hit;
		directory = dirname(directory);
	}
	return null;
}

/** 探测结果缓存上限。session 每轮 assembly 都会求值，探测要 readdirSync 多次，必须缓存。 */
const CACHE_LIMIT = 256;

/**
 * 有界 FIFO 缓存：key 是起始 cwd，value 是探测结果（含 null）。
 *
 * 只按起始目录缓存，不掺 mtime 之类的复杂逻辑：session 换目录后 key 变化，
 * 下一轮自然重新探测。上限 256 足够覆盖一个进程里出现过的会话目录，
 * 又不会随 `cd` 次数无限增长。
 *
 * @type {Map<string, object | null>}
 */
const projectRootCache = new Map();

/**
 * 带缓存的 {@link findProjectRoot}。
 * @param {string} from 起始绝对目录。
 * @returns {{ root: string, kind: "engine" | "game", name: string } | null}
 */
function cachedFindProjectRoot(from) {
	if (projectRootCache.has(from)) return projectRootCache.get(from) ?? null;
	const hit = findProjectRoot(from);
	if (projectRootCache.size >= CACHE_LIMIT) {
		const oldest = projectRootCache.keys().next();
		if (!oldest.done) projectRootCache.delete(oldest.value);
	}
	projectRootCache.set(from, hit);
	return hit;
}

/**
 * 读取 session 的起始工作目录。
 *
 * 形状来自 DSH agent：`context = { agent, scope, signal }`，
 * `context.agent.session.header.cwd` 是会话创建时的绝对目录。
 *
 * 已知边界：用户在会话中 `cd` 之后 header.cwd 不变（变更记录在
 * `working-directory/change` 事件里）。这里故意不追投影状态，理由有二：
 * 1. `working-directory` 服务在部分 composition 里不存在，为一个提示句引入
 *    可选依赖不划算；2. `cd` 进 UE 子目录的上游场景，其父链上本来就有 marker，
 *    只有「从非 UE 目录 cd 进 UE 目录」这一种情况会漏，下一轮新建会话即恢复。
 *
 * @param {object | undefined} context prompt assembly 上下文。
 * @returns {string | undefined} 绝对目录。
 */
function resolveSessionCwd(context) {
	try {
		const cwd = context?.agent?.session?.header?.cwd;
		return typeof cwd === "string" && cwd.length > 0 ? cwd : undefined;
	} catch {
		return undefined;
	}
}

/**
 * 生成注入 system prompt 的那一句 UE 上下文。
 *
 * 文本策略：**刻意极短**。它每轮都占 context（assembly 每次求值，渲染进系统消息），
 * 所以只写模型不能自己推断、且能改变行为的三件事：这是 UE 工程、用 UE 代码约定、
 * 有 `unreal-mcp` 技能可用。未命中返回空串 —— DSH 的 renderPrompt 会
 * `.filter(text => text.length > 0)` 丢掉空 section，不会污染 prompt。
 *
 * 注意不要在这里放 `{{...}}`：本 section 以 `interpolate: false` 注册，
 * 花括号是字面量，但保持纯文本能让文本在日志/测试里更好读。
 *
 * @param {object | undefined} context prompt assembly 上下文。
 * @returns {string} 注入文本，或空串。
 */
function projectSectionText(context) {
	const cwd = resolveSessionCwd(context);
	if (cwd === undefined) return "";
	const hit = cachedFindProjectRoot(cwd);
	if (hit === null) return "";
	const identity =
		hit.kind === "engine"
			? "This working directory is inside an Unreal Engine source tree."
			: `This working directory is inside an Unreal Engine project (\`${hit.name}.uproject\`).`;
	return `${identity} Prefer Unreal Engine conventions (C++/UObject patterns, Slate, UHT reflection) when suggesting code. Use the \`unreal-mcp\` skill to drive the live Unreal Editor through the MCP server; if its tools look missing, start the server in the editor with \`ModelContextProtocol.StartServer\`.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 插件入口
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 注册 bundled skill provider 与 UE 工程 prompt section。
 *
 * @param {object} ctx Cordis 上下文（已保证 `skills` 可用）。
 */
export function apply(ctx) {
	// ── 1. bundled skill provider ─────────────────────────────────────────────
	// 与 `@deepseek-ai/dsh-skill-badge` 同构：registerProvider 收一个工厂，
	// 工厂返回 `{ name, list, get }`。list() 返回数组即「完整观测」；
	// 返回 `{ candidates, complete }` 可表达不完整（本 provider 不会不完整，
	// 除非包损坏，此时我们选择少广告而不是标记 incomplete —— 少一个技能的
	// 影响面比整份技能目录不可缓存更小）。
	const candidates = buildCandidates(ctx);
	const provider = {
		name: PROVIDER_NAME,
		list() {
			return Promise.resolve(candidates);
		},
		get(candidate) {
			return Promise.resolve(loadDefinition(candidate));
		},
	};
	ctx.skills.registerProvider(() => provider);

	// ── 2. UE 工程 prompt section ────────────────────────────────────────────
	// systemPrompt 是**可选**依赖：没有它的 profile 不能因此装载失败。
	// 顺序取 MCP_SERVERS（= 3100）之后 5，即紧跟「MCP 服务器」那段说明，
	// 让模型先读到「有哪些 MCP server」，再读到「当前目录是 UE 工程」。
	ctx.inject(["systemPrompt"], (inner) => {
		const baseOrder = typeof inner.systemPrompt.getSectionOrder === "function" ? inner.systemPrompt.getSectionOrder("MCP_SERVERS") : undefined;
		const order = Number.isFinite(baseOrder) ? baseOrder + 5 : 3105;
		inner.systemPrompt.section({
			name: "unreal-mcp:project",
			order,
			// 文本是纯字符串，但关掉插值可以保证任何未来的 `{{...}}` 都按字面渲染，
			// 也避免与 prompt 变量注册表耦合（未注册的变量会 throw，导致整次 assembly 失败）。
			interpolate: false,
			text: projectSectionText,
		});
	});
}
