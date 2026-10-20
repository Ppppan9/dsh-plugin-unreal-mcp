/**
 * plugin-unit.test.mjs —— 用假 ctx 加载 plugin/index.js，断言它的注册内容与 UE 工程探测。
 *
 * 覆盖：
 *   A1  bundle 清单（package.json 的 dsh.bundle.patch 指向存在的文件、cordis.patch.yml 可解析且含两行）
 *   A3  skills provider 恰好注册 3 个 candidate（名字/描述/provider/rank/modelInvocable/resourceBase）
 *   A3' get() 返回的 content 非空、无未填充占位、使用 DSH 前缀工具名、无 Claude Code 残留
 *   prompt section 注册字段正确（name / order / interpolate:false / text 是函数）
 *   A4  UE 工程探测：5 种目录情形（含「只有 Engine/ 不算工程」这个 Epic 明确警告的坑）
 *
 * 为什么要假 ctx：真 cordis 组合属于 integration.test.mjs 的范围；本文件只验「插件注册了什么」，
 * 用最小假 ctx 把契约钉死，失败信息也更直接。
 *
 * 运行：
 *   ELECTRON_RUN_AS_NODE=1 "<dsh-node>" plugin-unit.test.mjs
 */

import { createRequire } from 'node:module';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TESTS_DIR = HERE;
const PLUGIN_DIR = resolve(HERE, '..');
const PLUGIN_ENTRY = join(PLUGIN_DIR, 'index.js');

const APP_ASAR = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar';
const ASAR_NM = `${APP_ASAR}/dsh/node_modules`;

// ---------------------------------------------------------------------------
// 极简断言框架
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures = [];
let currentGroup = '';

function group(name) {
  currentGroup = name;
  console.log(`\n── ${name} ──`);
}
function check(label, fn) {
  try {
    const r = fn();
    if (r === false) throw new Error('assertion returned false');
    passed++;
    console.log(`  PASS  ${label}`);
  } catch (e) {
    failed++;
    const msg = e && e.message ? e.message : String(e);
    failures.push({ group: currentGroup, label, msg });
    console.log(`  FAIL  ${label}`);
    console.log(`        → ${msg.split('\n').slice(0, 3).join('\n          ')}`);
  }
}
async function checkAsync(label, fn) {
  try {
    const r = await fn();
    if (r === false) throw new Error('assertion returned false');
    passed++;
    console.log(`  PASS  ${label}`);
  } catch (e) {
    failed++;
    const msg = e && e.message ? e.message : String(e);
    failures.push({ group: currentGroup, label, msg });
    console.log(`  FAIL  ${label}`);
    console.log(`        → ${msg.split('\n').slice(0, 3).join('\n          ')}`);
  }
}
function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what || 'value'}: expected ${e}, got ${a}`);
}
function ok(cond, msg) {
  if (!cond) throw new Error(msg || 'condition not met');
}
function includes(haystack, needle, what) {
  if (typeof haystack !== 'string' || !haystack.includes(needle)) {
    throw new Error(
      `${what || 'value'} 应包含 ${JSON.stringify(needle)}；实际片段: ${JSON.stringify(String(haystack).slice(0, 160))}`,
    );
  }
}
function notIncludes(haystack, needle, what) {
  if (typeof haystack === 'string' && haystack.includes(needle)) {
    throw new Error(`${what || 'value'} 不应包含 ${JSON.stringify(needle)}`);
  }
}

// ---------------------------------------------------------------------------
// 假 ctx：只实现插件会用到的 cordis / DSH 服务面
// ---------------------------------------------------------------------------
function makeFakeContext() {
  const record = {
    providers: [], // registerProvider 的工厂函数
    sections: [], // systemPrompt.section 的参数
    injectCalls: [], // inject([...], cb)
    effects: [], // effect(fn, label)
    logs: [],
  };

  const SECTION_ORDER = {
    HARNESS_IDENTITY: 100,
    DEPLOYMENT_PERSONA_PREFIX: 200,
    DEPLOYMENT_PERSONA_SUFFIX: 300,
    RUNTIME_CONTEXT: 1000,
    MCP_SERVERS: 3100,
    TOOL_ORDER_REST: 4000,
  };

  const logger = {
    debug: (...a) => record.logs.push(['debug', ...a]),
    info: (...a) => record.logs.push(['info', ...a]),
    warn: (...a) => record.logs.push(['warn', ...a]),
    error: (...a) => record.logs.push(['error', ...a]),
  };

  const systemPrompt = {
    section(section) {
      if (!section || typeof section !== 'object') throw new TypeError('section() 需要对象参数');
      record.sections.push(section);
      return () => {};
    },
    getSectionOrder(name) {
      if (!(name in SECTION_ORDER)) throw new Error(`未知 section order 名: ${name}`);
      return SECTION_ORDER[name];
    },
    tools() {
      return () => {};
    },
  };

  const skills = {
    registerProvider(create) {
      if (typeof create !== 'function') throw new TypeError('registerProvider() 需要工厂函数');
      record.providers.push(create);
      return () => {};
    },
  };

  const disposer = () => {};

  const ctx = {
    // ---- 服务 ----
    skills,
    systemPrompt,
    logger,

    // ---- cordis 常用面 ----
    /**
     * inject(names, callback)：真 cordis 是「服务就绪后回调」。假 ctx 里所有服务
     * 一开始就在，所以同步回调，inner 与 ctx 相同（并额外保证 inner.systemPrompt 可用）。
     */
    inject(names, callback) {
      const list = Array.isArray(names) ? names : [names];
      record.injectCalls.push({ names: list, callback });
      if (typeof callback === 'function') {
        const inner = { ...ctx };
        const ret = callback(inner);
        return typeof ret === 'function' ? ret : disposer;
      }
      return disposer;
    },
    effect(fn, label) {
      record.effects.push({ fn, label });
      const ret = typeof fn === 'function' ? fn() : undefined;
      return typeof ret === 'function' ? ret : disposer;
    },
    on() {
      return disposer;
    },
    off() {},
    emit() {},
    get(name) {
      if (name === 'skills') return skills;
      if (name === 'systemPrompt') return systemPrompt;
      if (name === 'logger') return logger;
      return undefined;
    },
    set() {
      return true;
    },
    plugin() {
      return () => {};
    },
    scope: undefined,
    root: undefined,
    fiber: { uid: null },
    extend() {
      return ctx;
    },
  };
  ctx.root = ctx;
  // 挂到 ctx 上，便于只拿到 ctx 的调用点回取记录
  Object.defineProperty(ctx, '__record', { value: record, enumerable: false });
  return { ctx, record };
}

// ---------------------------------------------------------------------------
// UE 工程探测用临时目录
// ---------------------------------------------------------------------------
function makeTempTree(spec) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ue-detect-'));
  for (const [rel, content] of Object.entries(spec)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    if (content === null) {
      mkdirSync(abs, { recursive: true });
    } else if (typeof content === 'string') {
      writeFileSync(abs, content);
    }
  }
  return root;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
console.log('═══ plugin-unit.test.mjs — 假 ctx 验 bundle 注册契约与 UE 工程探测 ═══');
console.log(`插件目录: ${PLUGIN_DIR}`);

const tempDirs = [];
let pluginModule;
let captured;
let degradedPluginPath = null;
let degradedRecord = null;

try {
  // =========================================================================
  // A1. bundle 清单
  // =========================================================================
  group('A1. bundle 清单：package.json + cordis.patch.yml');

  const pkgPath = join(PLUGIN_DIR, 'package.json');
  let pkg;

  check('plugin/package.json 存在且是合法 JSON', () => {
    ok(existsSync(pkgPath), `${pkgPath} 不存在`);
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  });

  check('package.json: name / version / type / license', () => {
    eq(pkg.name, 'dsh-plugin-unreal-mcp', 'name');
    eq(pkg.version, '1.0.0', 'version');
    eq(pkg.type, 'module', 'type');
    eq(pkg.license, 'MIT', 'license');
    // 开源发布形态：不应带 private，repository/homepage 指向 GitHub 仓库
    ok(pkg.private !== true, '开源包不应声明 private: true');
    ok(pkg.repository && /github\.com/.test(pkg.repository.url), '应声明 GitHub repository');
  });

  check('package.json: main 指向存在的入口，dsh.bundle.patch 指向存在的 patch', () => {
    eq(pkg.main, './index.js', 'main');
    ok(existsSync(join(PLUGIN_DIR, pkg.main)), `main 文件不存在: ${pkg.main}`);
    ok(pkg.dsh && pkg.dsh.bundle, 'package.json 缺少 dsh.bundle');
    const patch = pkg.dsh.bundle.patch;
    ok(typeof patch === 'string' && patch.length > 0, 'dsh.bundle.patch 应为非空字符串');
    const patchAbs = resolve(PLUGIN_DIR, patch);
    ok(existsSync(patchAbs), `dsh.bundle.patch 指向的文件不存在: ${patch} → ${patchAbs}`);
  });

  let patchDoc;

  /**
   * 用 **DSH loader 自己的 YAML 方言** 解析 patch：
   * @deepseek-ai/dsh-app-boot 里定义的是
   *     const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {...})
   *     const entryListSchema = yaml.JSON_SCHEMA.extend(JsExpr)
   * 也就是说 `!!js` 是合法方言，会被解析成 `{ __jsExpr: '<源码>' }` 节点，
   * 由 loader 在 entry 激活时求值。用裸 `yaml` 包解析会得到 "Unresolved tag" 警告
   * 且把 `!!js` 标量当成普通字符串 —— 那会漏掉「url 其实是表达式」这个关键事实。
   */
  function loadEntryList(text) {
    const require = createRequire(import.meta.url);
    const yaml = require(`${ASAR_NM}/js-yaml/dist/js-yaml.js`);
    const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
      kind: 'scalar',
      resolve: (data) => typeof data === 'string',
      construct: (data) => ({ __jsExpr: data }),
    });
    return yaml.load(text, { schema: yaml.JSON_SCHEMA.extend(JsExpr) });
  }

  check('cordis.patch.yml 能被 DSH loader 的 YAML 方言（JSON_SCHEMA + !!js）解析', () => {
    const patchPath = resolve(PLUGIN_DIR, pkg.dsh.bundle.patch);
    patchDoc = loadEntryList(readFileSync(patchPath, 'utf8'));
    ok(Array.isArray(patchDoc), 'entry list 解析结果应为数组');
    ok(patchDoc[0] && Array.isArray(patchDoc[0].insert), '应有 insert 列表');
  });

  check('!!js 表达式被正确解析为表达式节点（不是被当成字符串丢掉）', () => {
    const client = patchDoc[0].insert.find((e) => e.id === 'unreal-mcp-client');
    ok(client, '应有 unreal-mcp-client 行');
    const urlNode = client.config && client.config.url;
    ok(urlNode !== undefined, 'client 行应配置 url');
    if (urlNode && typeof urlNode === 'object' && '__jsExpr' in urlNode) {
      // 期望形态：!!js 表达式
      includes(urlNode.__jsExpr, 'UNREAL_MCP_PORT', 'url 的 !!js 表达式');
      includes(urlNode.__jsExpr, '8000', 'url 的 !!js 表达式应回落 8000');
      console.log(`        url = !!js ${urlNode.__jsExpr.slice(0, 80)}…`);
    } else {
      // 也接受纯字符串写法，但必须包含默认端口
      ok(typeof urlNode === 'string', `url 应为字符串或 !!js 表达式，实际 ${typeof urlNode}`);
      includes(urlNode, '8000', 'url 字符串');
      console.log(`        url = ${urlNode}`);
    }
  });

  check('patch 的 config 字段值正确（serverName / timeout / reconnect / failOnStartupError）', () => {
    const client = patchDoc[0].insert.find((e) => e.id === 'unreal-mcp-client');
    const c = client.config;
    eq(c.serverName, 'unreal', 'serverName');
    eq(c.transport, 'streamable-http', 'transport');
    eq(c.toolCallTimeoutMs, 300000, 'toolCallTimeoutMs');
    eq(c.failOnStartupError, false, 'failOnStartupError');
    eq(c.reconnect.enabled, true, 'reconnect.enabled');
    eq(c.reconnect.initialDelayMs, 1000, 'reconnect.initialDelayMs');
    eq(c.reconnect.maxDelayMs, 30000, 'reconnect.maxDelayMs');
    eq(c.reconnect.maxAttempts, 100000, 'reconnect.maxAttempts');
    eq(client.name, '@deepseek-ai/dsh-mcp-client', 'client.name');
  });

  check('patch 第二行是本 bundle 自己（dsh-plugin-unreal-mcp），且 config 为空对象', () => {
    const self = patchDoc[0].insert.find((e) => e.id === 'unreal-mcp');
    ok(self, '应有 unreal-mcp 行');
    eq(self.name, 'dsh-plugin-unreal-mcp', 'self.name');
    eq(self.config, {}, 'self.config');
  });

  check('patch 含两行 insert：unreal-mcp-client 与 unreal-mcp', () => {
    const text = readFileSync(resolve(PLUGIN_DIR, pkg.dsh.bundle.patch), 'utf8');
    for (const id of ['unreal-mcp-client', 'unreal-mcp']) {
      includes(text, id, 'patch 文本');
    }
    includes(text, '@deepseek-ai/dsh-mcp-client', 'patch 文本');
  });

  check('patch 的 client 行是 streamable-http + 默认 8000 端口 + 未设 failOnStartupError:true', () => {
    const text = readFileSync(resolve(PLUGIN_DIR, pkg.dsh.bundle.patch), 'utf8');
    includes(text, 'streamable-http', 'patch 文本');
    includes(text, '8000', 'patch 文本');
    includes(text, 'serverName', 'patch 文本');
    includes(text, 'unreal', 'patch 文本');
    // toolCallTimeoutMs 要给足（UE 的 tools/call 阻塞到 game thread 跑完）
    const m = text.match(/toolCallTimeoutMs:\s*(\d+)/);
    ok(m, 'patch 应显式设置 toolCallTimeoutMs');
    ok(Number(m[1]) >= 60_000, `toolCallTimeoutMs 应 ≥60000，实际 ${m[1]}`);
  });

  // =========================================================================
  // 加载 plugin/index.js
  // =========================================================================
  group('0. 加载 plugin/index.js（真 ESM，裸依赖重定向进 asar）');

  /**
   * plugin/index.js 会 `import { BUNDLED_SKILL_RANK } from '@deepseek-ai/dsh-skill'`。
   * 插件的运行位置在 DSH 安装目录内，那里能解析到这个包；测试从 workspace 加载，
   * 所以要显式把裸说明符重定向到 asar 里的真包（不是假 stub —— 常量必须是真的）。
   */
  await checkAsync('注册 module hook，把 @deepseek-ai/dsh-skill 指向 asar 内真包', async () => {
    const realSkillPkg = `${ASAR_NM}/@deepseek-ai/dsh-skill/lib/index.js`;
    ok(existsSync(realSkillPkg), `asar 内 dsh-skill 不存在: ${realSkillPkg}`);
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === '@deepseek-ai/dsh-skill') {
          return { url: pathToFileURL(realSkillPkg).href, shortCircuit: true };
        }
        return nextResolve(specifier, context);
      },
    });
  });

  await check('index.js 是零依赖 ESM（不 import 任何 @deepseek-ai/* 运行时包）', () => {
    // spec §6 要求纯 ESM 零依赖；Lead 补充：profile 插件解析不到 @deepseek-ai/dsh-skill，
    // 因此实现应把 BUNDLED_SKILL_RANK=600 内联成常量。
    const src = readFileSync(PLUGIN_ENTRY, 'utf8');
    const bareImports = [...src.matchAll(/from\s+['"]([^'".][^'"]*)['"]/g)].map((m) => m[1]);
    const nonBuiltin = bareImports.filter((spec) => !spec.startsWith('node:'));
    eq(nonBuiltin, [], `index.js 不应有非 node: 裸导入（实际: ${JSON.stringify(nonBuiltin)}）`);
    // 常量必须内联为 600
    ok(/\b600\b/.test(src), 'index.js 应内联 BUNDLED_SKILL_RANK = 600');
  });

  await checkAsync('plugin/index.js 能被 import，且导出 apply 与 inject', async () => {
    ok(existsSync(PLUGIN_ENTRY), `${PLUGIN_ENTRY} 不存在`);
    pluginModule = await import(pathToFileURL(PLUGIN_ENTRY).href);
    ok(typeof pluginModule.apply === 'function', '应导出 apply 函数');
    ok(pluginModule.inject !== undefined, '应导出 inject');
    eq(pluginModule.inject, ['skills'], 'inject 声明');
  });

  await check('index.js 导出的 name（若有）为字符串', () => {
    if (pluginModule.name !== undefined) {
      ok(typeof pluginModule.name === 'string' && pluginModule.name.length > 0, 'name 应为非空字符串');
    }
  });

  // =========================================================================
  // A3-降级. skills/ 缺失时必须优雅降级（独立正确性契约）
  // =========================================================================
  group('A3-降级. skills 缺失时优雅降级：apply 不抛 + list 返回 0');

  /**
   * 这是一个**独立的**正确性契约，不是「3 个 candidate」那条失败项的副作用：
   * provider 的 list() 在 skills 文本缺失时应当返回空数组（DSH 侧表现为技能不出现），
   * 而不是抛异常 —— 抛异常会连累整个插件的 apply，让 UE 探测 prompt section 也一起失效。
   * 做法：把 plugin/ 复制到临时目录并删掉 skills/，加载那份副本，不碰真交付物。
   */
  await checkAsync('复制 plugin/ 到临时目录并移除 skills/（不修改真交付物）', async () => {
    const { cpSync } = await import('node:fs');
    const copyRoot = mkdtempSync(join(tmpdir(), 'dsh-ue-noskills-'));
    tempDirs.push(copyRoot);
    const copyPlugin = join(copyRoot, 'plugin');
    cpSync(PLUGIN_DIR, copyPlugin, { recursive: true });
    rmSync(join(copyPlugin, 'skills'), { recursive: true, force: true });
    ok(!existsSync(join(copyPlugin, 'skills')), '副本的 skills/ 应已删除');
    degradedPluginPath = join(copyPlugin, 'index.js');
    ok(existsSync(degradedPluginPath), `副本入口不存在: ${degradedPluginPath}`);
    console.log(`        降级副本: ${copyPlugin}`);
  });

  await checkAsync('skills/ 缺失时 import + apply() 都不抛异常', async () => {
    const mod = await import(pathToFileURL(degradedPluginPath).href);
    ok(typeof mod.apply === 'function', '降级副本应仍导出 apply');
    const made = makeFakeContext();
    await Promise.resolve(mod.apply(made.ctx, {}));
    degradedRecord = made.record;
  });

  await checkAsync('skills/ 缺失时 list() 返回 0 个 candidate（而非 throw / 残缺项）', async () => {
    ok(degradedRecord, '降级 ctx 记录缺失');
    ok(degradedRecord.providers.length >= 1, '仍应注册 provider（注册动作本身不依赖文件）');
    const p2 = degradedRecord.providers[0]();
    const list = await p2.list();
    ok(Array.isArray(list), 'list() 应返回数组而不是抛异常');
    eq(list.length, 0, 'skills/ 缺失时 candidate 数量');
    console.log('        skills/ 缺失 → list() 返回 []，未抛异常 ✓');
  });

  await checkAsync('skills/ 缺失时 get() 若被调用也不抛（防御性）', async () => {
    // DSH 只会对 list() 返回的 candidate 调 get()，正常不会调到；
    // 但 provider 实现不应在这种情况下崩溃（属于防御性契约，失败不阻断）。
    const p2 = degradedRecord.providers[0]();
    let threw = null;
    try {
      const out = await p2.get({ name: 'unreal-mcp', locator: '/nonexistent/path' });
      ok(out);
    } catch (e) {
      threw = e;
    }
    // 允许抛（文件确实不存在），但必须是可诊断的错误而不是 TypeError
    if (threw) {
      ok(
        !(threw instanceof TypeError),
        `缺失文件时应抛可诊断错误，而不是 TypeError: ${threw.message}`,
      );
      console.log(`        get() 在缺文件时抛可诊断错误（可接受）: ${threw.message.slice(0, 70)}`);
    } else {
      console.log('        get() 在缺文件时未抛（也接受）');
    }
  });

  await checkAsync('skills/ 缺失时 prompt section 仍然注册成功（不被 skills 拖垮）', async () => {
    ok(degradedRecord, '降级 ctx 记录缺失');
    const sec = degradedRecord.sections.find((x) => x.name === 'unreal-mcp:project');
    ok(sec, 'skills/ 缺失时 prompt section 仍应注册（二者解耦）');
    ok(typeof sec.text === 'function', 'section.text 仍应是函数');
  });

  // =========================================================================
  // apply() 现场捕获
  // =========================================================================
  group('A3. apply() 注册内容');

  const { ctx, record } = makeFakeContext();
  captured = record;

  await checkAsync('apply(ctx, {}) 不抛异常', async () => {
    await Promise.resolve(pluginModule.apply(ctx, {}));
  });

  await check('apply 通过 ctx.skills.registerProvider 注册了 provider', () => {
    ok(record.providers.length >= 1, `registerProvider 调用次数 = ${record.providers.length}`);
  });

  let provider;
  let candidates = [];

  await checkAsync('provider 工厂返回 { name, list, get } 三件套', async () => {
    provider = record.providers[0]();
    ok(provider && typeof provider === 'object', 'provider 应为对象');
    ok(typeof provider.name === 'string' && provider.name.length > 0, 'provider.name 应为非空字符串');
    ok(typeof provider.list === 'function', 'provider.list 应为函数');
    ok(typeof provider.get === 'function', 'provider.get 应为函数');
    console.log(`        provider.name = ${provider.name}`);
  });

  await checkAsync('list() 返回恰好 3 个 candidate', async () => {
    candidates = await provider.list();
    ok(Array.isArray(candidates), 'list() 应返回数组');
    eq(candidates.length, 3, 'candidate 数量');
    console.log(`        candidates = ${JSON.stringify(candidates.map((c) => c.name))}`);
  });

  await check('3 个 candidate 名字为 unreal-mcp / create-toolset / unreal-skill', () => {
    eq(
      candidates.map((c) => c.name).sort(),
      ['create-toolset', 'unreal-mcp', 'unreal-skill'],
      'candidate 名字',
    );
  });

  await check('每个 candidate：kebab-case 名、非空 description', () => {
    for (const c of candidates) {
      ok(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(c.name), `candidate 名不是 kebab-case: ${c.name}`);
      ok(
        typeof c.description === 'string' && c.description.trim().length > 0,
        `${c.name} 的 description 为空`,
      );
    }
  });

  await check('每个 candidate：provider 名一致、rank = 600（BUNDLED_SKILL_RANK）', () => {
    for (const c of candidates) {
      eq(c.provider, provider.name, `${c.name}.provider`);
      eq(c.rank, 600, `${c.name}.rank`);
    }
  });

  await check('每个 candidate：invocation 两个开关都为 true', () => {
    for (const c of candidates) {
      ok(c.invocation && typeof c.invocation === 'object', `${c.name}.invocation 缺失`);
      eq(c.invocation.modelInvocable, true, `${c.name}.invocation.modelInvocable`);
      eq(c.invocation.userInvocable, true, `${c.name}.invocation.userInvocable`);
    }
  });

  await check('每个 candidate：source 为非空字符串', () => {
    for (const c of candidates) {
      ok(typeof c.source === 'string' && c.source.length > 0, `${c.name}.source 应为非空字符串`);
    }
  });

  /**
   * resourceBase 的类型是 dsh-skill 里的闭集 SkillResourceBase：
   *   { kind: 'directory', path } | { kind: 'url', url } | { kind: 'opaque', description }
   * （见 dsh-skill/lib/index.js → renderResourceHint，按 base.kind 分支渲染）
   * bundled skill 应该用 directory，并且 path 必须真实存在，否则模型按相对路径找不到 references/。
   */
  await check('每个 candidate：resourceBase 是 {kind:"directory", path} 且目录真实存在', () => {
    for (const c of candidates) {
      const rb = c.resourceBase;
      ok(rb && typeof rb === 'object', `${c.name}.resourceBase 缺失或不是对象: ${JSON.stringify(rb)}`);
      eq(rb.kind, 'directory', `${c.name}.resourceBase.kind（bundled skill 应为 directory）`);
      ok(typeof rb.path === 'string' && rb.path.length > 0, `${c.name}.resourceBase.path 缺失`);
      ok(existsSync(rb.path), `${c.name}.resourceBase.path 目录不存在: ${rb.path}`);
      ok(statSync(rb.path).isDirectory(), `${c.name}.resourceBase.path 不是目录`);
      console.log(`        ${c.name}.resourceBase = ${rb.path}`);
    }
  });

  await check('每个 candidate：locator 指向真实存在的 SKILL.md，且与 resourceBase 同目录', () => {
    for (const c of candidates) {
      const loc = c.locator;
      ok(loc && typeof loc === 'object', `${c.name}.locator 缺失或不是对象`);
      ok(typeof loc.path === 'string' && loc.path.length > 0, `${c.name}.locator.path 缺失`);
      ok(existsSync(loc.path), `${c.name}.locator.path 文件不存在: ${loc.path}`);
      ok(loc.path.endsWith('SKILL.md'), `${c.name}.locator.path 应指向 SKILL.md，实际 ${loc.path}`);
      eq(loc.directory, c.resourceBase.path, `${c.name}.locator.directory 应与 resourceBase.path 一致`);
    }
  });

  // =========================================================================
  // get() 返回的正文
  // =========================================================================
  group("A3'. get() 正文内容");

  const bodies = new Map();

  await checkAsync('3 个 candidate 的 get() 都返回 content 非空', async () => {
    for (const c of candidates) {
      const def = await provider.get(c);
      ok(def && typeof def === 'object', `${c.name}: get() 应返回对象`);
      ok(typeof def.content === 'string' && def.content.trim().length > 0, `${c.name}: content 为空`);
      bodies.set(c.name, def.content);
      console.log(`        ${c.name}: content ${def.content.length} 字符`);
    }
  });

  await check('get() 返回的 definition 回填了 candidate 的 name（便于注册表对齐）', async () => {
    for (const c of candidates) {
      const def = await provider.get(c);
      if (def.name !== undefined) eq(def.name, c.name, `${c.name}: definition.name`);
    }
  });

  await check('SKILL.md 正文有实质内容（>300 字符）', () => {
    for (const c of candidates) {
      const body = bodies.get(c.name) || '';
      ok(body.length > 300, `${c.name}: 正文仅 ${body.length} 字符，缺少实质内容`);
    }
  });

  await check('正文不含未填充的前端/模板占位', () => {
    const badPatterns = [
      { re: /\$\{[A-Za-z_][A-Za-z0-9_]*\}/, what: '${...}' },
      { re: /\{\{\s*[A-Za-z_][A-Za-z0-9_.]*\s*\}\}/, what: '{{...}}' },
      { re: /\bTODO\b/, what: 'TODO' },
      { re: /\bTBD\b/, what: 'TBD' },
      { re: /\bFIXME\b/, what: 'FIXME' },
      { re: /<PLACEHOLDER>/i, what: '<PLACEHOLDER>' },
      { re: /\bLorem ipsum\b/i, what: 'Lorem ipsum' },
    ];
    for (const [name, body] of bodies) {
      for (const { re, what } of badPatterns) {
        const m = body.match(re);
        ok(!m, `${name}: 正文含未填充占位 ${what} → ${m && m[0]}`);
      }
    }
  });

  await check('工具名使用 DSH 前缀 mcp__unreal__（不是裸工具名）', () => {
    const all = [...bodies.values()].join('\n');
    for (const t of ['mcp__unreal__list_toolsets', 'mcp__unreal__describe_toolset', 'mcp__unreal__call_tool']) {
      includes(all, t, '技能正文');
    }
  });

  await check('没有 Claude Code 专属残留（--dangerously-skip-permissions / CLAUDE_PLUGIN_ROOT）', () => {
    const all = [...bodies.values()].join('\n');
    notIncludes(all, '--dangerously-skip-permissions', '技能正文');
    notIncludes(all, 'CLAUDE_PLUGIN_ROOT', '技能正文');
    notIncludes(all, 'SessionStart', '技能正文');
  });

  await check('技能正文写清了三步契约（list_toolsets → describe_toolset → call_tool）', () => {
    const body = bodies.get('unreal-mcp') || '';
    includes(body, 'list_toolsets', 'unreal-mcp 技能');
    includes(body, 'describe_toolset', 'unreal-mcp 技能');
    includes(body, 'call_tool', 'unreal-mcp 技能');
    // 全限定 toolset 名 + 短 tool_name 这个坑必须在技能里出现
    includes(body, 'toolset_name', 'unreal-mcp 技能');
    includes(body, 'tool_name', 'unreal-mcp 技能');
  });

  await check('references/ 下的文件也存在于磁盘', () => {
    const refs = join(PLUGIN_DIR, 'skills', 'unreal-mcp', 'references');
    ok(existsSync(refs), `references 目录不存在: ${refs}`);
    const files = readdirSync(refs);
    for (const f of ['setup.md', 'operations.md']) {
      ok(files.includes(f), `references 下缺 ${f}；实际: ${JSON.stringify(files)}`);
    }
  });

  // =========================================================================
  // prompt section
  // =========================================================================
  group('A4-前置. prompt section 注册字段');

  let section;

  await check('apply 通过 ctx.inject(["systemPrompt"], …) 注册了 prompt section', () => {
    const sysInjects = record.injectCalls.filter((c) => c.names.includes('systemPrompt'));
    ok(sysInjects.length >= 1, '未观察到 systemPrompt 的 inject 调用');
    ok(record.sections.length >= 1, `systemPrompt.section 调用次数 = ${record.sections.length}`);
    section = record.sections[0];
  });

  await check('section: name = "unreal-mcp:project"', () => {
    eq(section.name, 'unreal-mcp:project', 'section.name');
  });

  await check('section: order = getSectionOrder("MCP_SERVERS") + 5 = 3105', () => {
    eq(section.order, 3105, 'section.order');
  });

  await check('section: interpolate = false', () => {
    eq(section.interpolate, false, 'section.interpolate');
  });

  await check('section: text 是函数（每次 assembly 求值）', () => {
    ok(typeof section.text === 'function', `section.text 类型为 ${typeof section.text}`);
  });

  // =========================================================================
  // A4. UE 工程探测：5 种目录情形
  // =========================================================================
  group('A4. UE 工程探测（含「只有 Engine/ 不算工程」这个坑）');

  const text = section.text;

  /** 构造 text() 的实参：context = { agent, scope, signal }，cwd 在 agent.session.header.cwd */
  function callText(cwd) {
    const context = {
      agent: { session: { header: { cwd } } },
      scope: undefined,
      signal: new AbortController().signal,
    };
    return text(context);
  }

  // 情形 (a)：有 Foo.uproject
  const dirA = makeTempTree({ 'Foo.uproject': '{"FileVersion":3,"EngineAssociation":"5.8"}' });
  tempDirs.push(dirA);

  await check('(a) 有 Foo.uproject → 命中，返回非空上下文', () => {
    const out = callText(dirA);
    ok(typeof out === 'string', `返回值应为字符串，实际 ${typeof out}`);
    ok(out.trim().length > 0, '命中 UE 工程时应返回非空上下文');
    includes(out, 'Foo', '上下文应提到工程名');
    console.log(`        输出: ${JSON.stringify(out)}`);
  });

  // 情形 (b)：有 GenerateProjectFiles.sh（Engine 源码树风格）
  const dirB = makeTempTree({
    'GenerateProjectFiles.sh': '#!/bin/bash\necho hi\n',
    'Engine/Source/Runtime/Engine/Engine.Build.cs': '// marker',
  });
  tempDirs.push(dirB);

  await check('(b) 有 GenerateProjectFiles.sh → 命中', () => {
    const out = callText(dirB);
    ok(out.trim().length > 0, '有 GenerateProjectFiles.sh 时应命中');
    console.log(`        输出: ${JSON.stringify(out)}`);
  });

  // 情形 (b2)：.bat 与 .command 变体
  const dirB2 = makeTempTree({ 'GenerateProjectFiles.bat': '@echo off\r\n' });
  tempDirs.push(dirB2);
  await check('(b2) 有 GenerateProjectFiles.bat → 命中', () => {
    ok(callText(dirB2).trim().length > 0, '.bat 也是合法 marker');
  });

  const dirB3 = makeTempTree({ 'GenerateProjectFiles.command': '#!/bin/bash\n' });
  tempDirs.push(dirB3);
  await check('(b3) 有 GenerateProjectFiles.command → 命中', () => {
    ok(callText(dirB3).trim().length > 0, '.command 也是合法 marker');
  });

  // 情形 (c)：只有 Engine/ 目录 —— Epic 源码明确警告的坑，绝不能命中
  const dirC = makeTempTree({
    'Engine/Source/Runtime/Engine/Engine.Build.cs': '// 看起来像引擎树，但没有工程 marker',
    'Engine/Binaries/DotNET/UnrealBuildTool.dll': 'binary-ish',
  });
  tempDirs.push(dirC);

  await check('(c) 只有 Engine/ 目录 → **不命中**（Epic 明确警告的坑）', () => {
    const out = callText(dirC);
    eq(out, '', '只有 Engine/ 时 text() 必须返回空字符串');
  });

  // 情形 (d)：完全普通目录
  const dirD = makeTempTree({
    'README.md': '# 普通项目\n',
    'src/index.ts': 'export {};\n',
  });
  tempDirs.push(dirD);

  await check('(d) 完全普通目录 → 不命中', () => {
    eq(callText(dirD), '', '普通目录应返回空字符串');
  });

  // 情形 (e)：从子目录向上走能命中（Epic hook 的核心行为）
  await check('(e) 从 Source/Sub/Deep 子目录向上走 → 命中根目录工程', () => {
    const sub = join(dirA, 'Source', 'Sub', 'Deep');
    mkdirSync(sub, { recursive: true });
    const out = callText(sub);
    ok(out.trim().length > 0, '应沿父链向上找到 Foo.uproject');
    includes(out, 'Foo', '上下文应提到工程名');
  });

  // 情形 (f)：Engine 树 + 工程 marker 同时存在 → 命中且标注为 engine 类型
  const dirF = makeTempTree({
    'GenerateProjectFiles.sh': '#!/bin/bash\n',
    'Engine/Source/Runtime/Engine/Engine.Build.cs': '// engine module',
  });
  tempDirs.push(dirF);
  await check('(f) Engine 树 + 工程 marker → 命中，且类型标注为 engine', () => {
    const out = callText(dirF);
    ok(out.trim().length > 0, '应命中');
    const lower = out.toLowerCase();
    ok(
      lower.includes('engine') || out.includes('引擎'),
      `Engine 源码树应被标注为 engine 类型，实际输出: ${JSON.stringify(out)}`,
    );
  });

  // 情形 (g)：.uproject 在更深一层，但中途经过只有 Engine/ 的目录 —— 不能在 Engine 处短路
  await check('(g) 中途经过 Engine/ 目录不在那里短路，继续向上到真工程根', () => {
    // 结构：root/(Foo.uproject) → Engine/(无 marker) → 从 Engine/Source 调用
    const sub = join(dirB, 'Engine', 'Source');
    const out = callText(sub);
    ok(out.trim().length > 0, '应跳过只含 Engine/ 的中间层，继续向上命中真 root');
    // 命中的必须是 root（有 GenerateProjectFiles.sh），不是 Engine/
    ok(
      !out.includes(join(dirB, 'Engine')),
      `不应把 Engine/ 当成工程根；输出: ${JSON.stringify(out)}`,
    );
  });

  group('A4-健壮性. 异常输入不应抛');

  await check('cwd 为 undefined → 返回空字符串不抛', () => {
    let out;
    try {
      out = text({ agent: undefined, scope: undefined, signal: undefined });
    } catch (e) {
      throw new Error(`text() 不应抛异常，实际抛出: ${e.message}`);
    }
    ok(typeof out === 'string', '应返回字符串');
    eq(out, '', '无 cwd 时应返回空字符串');
  });

  await check('cwd 为空字符串 → 返回空字符串不抛', () => {
    eq(callText(''), '');
  });

  await check('cwd 指向不存在的路径 → 返回空字符串不抛', () => {
    const ghost = join(tmpdir(), `dsh-ue-ghost-${Date.now()}-nope`);
    eq(callText(ghost), '');
  });

  await check('text 是幂等的（重复调用同一 cwd 结果一致）', () => {
    const a = callText(dirA);
    const b = callText(dirA);
    eq(b, a, '重复调用结果');
  });

  await check('探测有缓存但不同目录不串味', () => {
    // 交替调用：命中 → 不命中 → 命中
    const x = callText(dirA);
    const y = callText(dirD);
    const z = callText(dirA);
    eq(y, '', '普通目录必须不命中');
    eq(z, x, '回到命中目录结果应一致（缓存命中也必须是正确值）');
  });

  // =========================================================================
  // 文件完整性
  // =========================================================================
  group('交付文件完整性');

  await check('plugin/skills/ 下三个 SKILL.md 都在', () => {
    for (const s of ['unreal-mcp', 'create-toolset', 'unreal-skill']) {
      const p = join(PLUGIN_DIR, 'skills', s, 'SKILL.md');
      ok(existsSync(p), `缺 ${p}`);
      ok(readFileSync(p, 'utf8').trim().length > 100, `${p} 内容过短`);
    }
  });

  await check('locale/en.json 与 locale/zh.json 都是合法 JSON 且有 meta 字段', () => {
    for (const f of ['en.json', 'zh.json']) {
      const p = join(PLUGIN_DIR, 'locale', f);
      ok(existsSync(p), `缺 ${p}`);
      const j = JSON.parse(readFileSync(p, 'utf8'));
      ok(j.meta && typeof j.meta === 'object', `${f} 缺 meta`);
      ok(typeof j.meta.title === 'string' && j.meta.title.length > 0, `${f}.meta.title 为空`);
      ok(
        typeof j.meta.description === 'string' && j.meta.description.length > 0,
        `${f}.meta.description 为空`,
      );
    }
  });

  await check('icon.svg 存在且是 SVG', () => {
    const p = join(PLUGIN_DIR, 'icon.svg');
    ok(existsSync(p), `缺 ${p}`);
    includes(readFileSync(p, 'utf8'), '<svg', p);
  });

  await check('LICENSE-Epic-Games-MIT.txt 含 Epic Games 版权行', () => {
    const p = join(PLUGIN_DIR, 'LICENSE-Epic-Games-MIT.txt');
    ok(existsSync(p), `缺 ${p}`);
    includes(readFileSync(p, 'utf8'), 'Epic Games', p);
  });

  await check('NOTICE.md 存在且说明了派生关系', () => {
    const p = join(PLUGIN_DIR, 'NOTICE.md');
    ok(existsSync(p), `缺 ${p}`);
    const t = readFileSync(p, 'utf8');
    ok(t.length > 100, 'NOTICE.md 内容过短');
    includes(t.toLowerCase(), 'epic', 'NOTICE.md');
  });
} catch (e) {
  failed++;
  failures.push({ group: '外层', label: '未捕获异常', msg: e?.stack || String(e) });
  console.log(`\n[外层异常] ${e?.stack || e}`);
} finally {
  for (const d of tempDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
console.log('\n══════════════════════════════════════════');
console.log(`plugin-unit: ${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  • [${f.group}] ${f.label}\n    ${f.msg.split('\n')[0]}`);
  process.exitCode = 1;
} else {
  console.log('结果: PASS —— bundle 注册契约与 UE 工程探测符合 SPEC');
}
