/**
 * integration.test.mjs —— 真 cordis Context + 真 dsh-mcp-client 插件 + UE 线路 mock。
 *
 * 验收目标（SPEC §4 / A6 / A7）：
 *   「真 mcp-client 插件能把 UE 工具注册成 mcp__unreal__*，并且实际能调用拿到结果」
 *
 * 本测试用的是**真的** DSH 组件，不是替身：
 *   - @deepseek-ai/cordis 的 Context（真依赖注入容器）
 *   - @deepseek-ai/dsh-system-prompt / dsh-tools 的真实服务实现（mcp-client 的 inject 依赖）
 *   - @deepseek-ai/dsh-mcp-client 的真实插件与 Config schema
 *   - @modelcontextprotocol/client 的真实 StreamableHTTPClientTransport
 *
 * 断言分四层：
 *   ① plugin/ 的 patch 配置能被真 Config schema 校验通过（配置正确性）
 *   ② 真 Context 组合后，3 个 mcp__unreal__* 工具出现在 ctx.tools 的可见视图里
 *   ③ 实际执行 call_tool 拿到可解析的 returnValue（端到端）
 *   ④ 派发语义的负面路径（全限定 tool_name / 缺 TOptional）也照实穿过于真链路
 *
 * 运行：
 *   ELECTRON_RUN_AS_NODE=1 "<dsh-node>" integration.test.mjs
 */

import { spawn } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(HERE, '..');
const MOCK = join(HERE, 'mock-unreal-mcp.mjs');

const APP_ASAR = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar';
const ASAR_NM = `${APP_ASAR}/dsh/node_modules`;

// ---------------------------------------------------------------------------
// 断言框架
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
    console.log(`        → ${msg.split('\n')[0]}`);
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
    console.log(`        → ${msg.split('\n')[0]}`);
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
  // 同时支持字符串子串与数组元素包含
  const contains =
    typeof haystack === 'string'
      ? haystack.includes(needle)
      : Array.isArray(haystack)
        ? haystack.includes(needle)
        : false;
  if (!contains) {
    throw new Error(
      `${what || 'value'} 应包含 ${JSON.stringify(needle)}；实际: ${JSON.stringify(haystack).slice(0, 200)}`,
    );
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 有界等待条件成立（避免固定 sleep 造成 flaky） */
async function waitFor(label, predicate, timeoutMs = 15_000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await predicate();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(intervalMs);
  }
  throw new Error(`等待超时 ${timeoutMs}ms: ${label}${last instanceof Error ? ` — ${last.message}` : ''}`);
}

/** 找一个当前空闲的本地端口（用于「先空端口、后起服务」的重连用例） */
async function getFreePort() {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// ---------------------------------------------------------------------------
// mock 进程
// ---------------------------------------------------------------------------
function startMock({ logPath, env = {}, port = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const args = [MOCK, String(port)];
    if (logPath) args.push('--log', logPath);
    const child = spawn(process.execPath, args, {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      // 独立进程组：父进程被强杀时也能整组清理，避免 mock 变孤儿
      detached: true,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`mock 启动超时。stdout=${out} stderr=${err}`));
    }, 10_000);
    child.stdout.on('data', (d) => {
      out += d.toString();
      const m = out.match(/MOCK_READY (\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve({ child, url: m[1] });
      }
    });
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('exit', (code) => {
      if (!/MOCK_READY/.test(out)) {
        clearTimeout(timer);
        reject(new Error(`mock 提前退出 code=${code}: ${err}`));
      }
    });
  });
}
/** 终止 mock：SIGTERM → 等 1.2s → SIGKILL；两种都尝试杀整个进程组，避免留孤儿进程 */
function stopMock(mock) {
  return new Promise((resolve) => {
    if (!mock || mock.child.exitCode !== null) {
      // 进程已退出
      if (mock) {
        try {
          process.kill(-mock.child.pid, 'SIGKILL');
        } catch {
          /* 组已不存在 */
        }
      }
      return resolve();
    }
    const pid = mock.child.pid;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      // 兜底：即使 exit 事件没来，也把整个进程组收掉
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* 组已不存在 */
      }
      resolve();
    };
    const t = setTimeout(() => {
      try {
        mock.child.kill('SIGKILL');
      } catch {}
      finish();
    }, 1200);
    mock.child.once('exit', () => {
      clearTimeout(t);
      finish();
    });
    try {
      mock.child.kill('SIGTERM');
    } catch {
      finish();
    }
  });
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
console.log('═══ integration.test.mjs — 真 cordis + 真 dsh-mcp-client + UE mock ═══');
console.log(`插件目录: ${PLUGIN_DIR}`);

const workDir = mkdtempSync(join(tmpdir(), 'dsh-ue-integ-'));
const obsLog = join(workDir, 'obs.jsonl');

let mock;
let ctx;

try {
  // =========================================================================
  // 0. 真依赖可用性
  // =========================================================================
  group('0. 真依赖加载（全部来自 DSH 安装包，非替身）');

  let cordis;
  let SystemPrompt;
  let ToolRuntime;
  let SkillRegistry;
  let mcp;

  await checkAsync('加载真 @deepseek-ai/cordis', async () => {
    cordis = await import(`${ASAR_NM}/@deepseek-ai/cordis/lib/index.js`);
    ok(typeof cordis.Context === 'function', 'Context 应为构造函数');
    console.log(`        cordis Context OK`);
  });

  await checkAsync('加载真 dsh-system-prompt / dsh-tools / dsh-skill 服务', async () => {
    SystemPrompt = (await import(`${ASAR_NM}/@deepseek-ai/dsh-system-prompt/lib/index.js`)).default;
    ToolRuntime = (await import(`${ASAR_NM}/@deepseek-ai/dsh-tools/lib/index.js`)).default;
    SkillRegistry = (await import(`${ASAR_NM}/@deepseek-ai/dsh-skill/lib/index.js`)).default;
    ok(typeof SystemPrompt === 'function', 'SystemPrompt 应为类');
    ok(typeof ToolRuntime === 'function', 'ToolRuntime 应为类');
    ok(typeof SkillRegistry === 'function', 'SkillRegistry 应为类');
  });

  await checkAsync('加载真 @deepseek-ai/dsh-mcp-client 插件（导出 Config/apply）', async () => {
    mcp = await import(`${ASAR_NM}/@deepseek-ai/dsh-mcp-client/lib/index.js`);
    ok(typeof mcp.apply === 'function', 'apply 应为函数');
    ok(mcp.Config !== undefined, 'Config 应存在');
    eq(mcp.inject, ['tools'], 'mcp-client 的 inject 声明');
    eq(mcp.name, 'mcp-client', 'mcp-client 的 name');
    console.log('        dsh-mcp-client OK（真插件）');
  });

  // =========================================================================
  // ① patch 配置 → 真 Config schema
  // =========================================================================
  group('① plugin patch 的配置能通过真 Config schema 校验');

  let patchedConfig;
  let patchSource = '';

  await checkAsync('从 plugin/cordis.patch.yml 抽出 client 行的 config（按 DSH loader 方言解析）', async () => {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    // 用 DSH loader 的真方言：js-yaml 的 JSON_SCHEMA + `!!js` Type（见 dsh-app-boot）。
    // `!!js` 会解析成 { __jsExpr: '<源码>' } 节点，需要在测试里显式求值（loader 在启动时求值）。
    const yaml = require(`${ASAR_NM}/js-yaml/dist/js-yaml.js`);
    const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
      kind: 'scalar',
      resolve: (data) => typeof data === 'string',
      construct: (data) => ({ __jsExpr: data }),
    });
    const entryListSchema = yaml.JSON_SCHEMA.extend(JsExpr);

    const pkg = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8'));
    const patchPath = resolve(PLUGIN_DIR, pkg.dsh.bundle.patch);
    patchSource = readFileSync(patchPath, 'utf8');
    const doc = yaml.load(patchSource, { schema: entryListSchema });
    ok(Array.isArray(doc), 'entry list 应解析为数组');

    // 递归找出所有带 name === '@deepseek-ai/dsh-mcp-client' 的节点，取其 config
    const found = [];
    const walk = (node) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      if (node.name === '@deepseek-ai/dsh-mcp-client') found.push(node);
      for (const v of Object.values(node)) walk(v);
    };
    walk(doc);
    ok(found.length === 1, `patch 里应恰好有 1 个 dsh-mcp-client 行，实际 ${found.length}`);
    patchedConfig = found[0].config ?? {};

    // 求值 !!js 节点（loader 的语义）：只支持这里用到的那个表达式形态。
    // 明确断言它引用了 UNREAL_MCP_PORT 与 8000，避免"表达式写错但测试放过"。
    const urlNode = patchedConfig.url;
    if (urlNode && typeof urlNode === 'object' && '__jsExpr' in urlNode) {
      includes(urlNode.__jsExpr, 'UNREAL_MCP_PORT', 'url 的 !!js 表达式');
      includes(urlNode.__jsExpr, '8000', 'url 的 !!js 表达式回落到 8000');
      // 用 Function 求值它（与 loader 语义一致：在进程环境里执行表达式）
      const evaluated = new Function('process', 'return (' + urlNode.__jsExpr + ');')(process);
      patchedConfig = { ...patchedConfig, url: evaluated };
      console.log(`        !!js url 求值结果 = ${evaluated}`);
    }
    console.log(`        patch config keys = ${Object.keys(patchedConfig).join(', ')}`);
  });

  await check('Config schema 接受 patch 配置（schema.parse / 可调用两种形态都试）', () => {
    const schema = mcp.Config;
    let resolved;
    if (typeof schema === 'function') {
      resolved = schema(patchedConfig);
    } else if (typeof schema.parse === 'function') {
      resolved = schema.parse(patchedConfig);
    } else {
      throw new Error(`不认识的 Config 形态: ${typeof schema}`);
    }
    ok(resolved && typeof resolved === 'object', 'schema 应返回解析后的配置');
    eq(resolved.transport, 'streamable-http', 'transport');
    eq(resolved.serverName, 'unreal', 'serverName');
    console.log(`        resolved: serverName=${resolved.serverName} transport=${resolved.transport} url=${resolved.url}`);
  });

  await check('解析后的默认值符合生产约束（failOnStartupError=false / 超时够大 / reconnect 次数大）', () => {
    const resolved = mcp.Config(patchedConfig);
    eq(resolved.failOnStartupError, false, 'failOnStartupError');
    ok(
      resolved.toolCallTimeoutMs >= 60_000,
      `toolCallTimeoutMs 应 ≥60000（UE tools/call 阻塞到 game thread 跑完），实际 ${resolved.toolCallTimeoutMs}`,
    );
    ok(resolved.reconnect && resolved.reconnect.enabled === true, 'reconnect.enabled 应为 true');
    ok(
      resolved.reconnect.maxAttempts >= 10,
      `reconnect.maxAttempts 应 ≥10（默认值 10 会导致编辑器晚开就丢工具），实际 ${resolved.reconnect.maxAttempts}`,
    );
    console.log(
      `        timeout=${resolved.toolCallTimeoutMs}ms attempts=${resolved.reconnect.maxAttempts} delay0=${resolved.reconnect.initialDelayMs}ms`,
    );
  });

  await check('patch 里 url 走默认 8000 端口（可用 UNREAL_MCP_PORT 覆盖）', () => {
    includes(patchSource, '8000', 'patch 文本');
    // 允许两种写法：!!js 表达式或纯字符串
    ok(
      /UNREAL_MCP_PORT/.test(patchSource) || /127\.0\.0\.1:8000/.test(patchSource),
      'patch 应包含默认 8000 或 UNREAL_MCP_PORT 覆盖表达式',
    );
  });

  await check('patch 拒绝把 serverName 写成非法值（schema 有约束）', () => {
    let threw = false;
    try {
      mcp.Config({ ...patchedConfig, serverName: 'bad name with spaces!' });
    } catch {
      threw = true;
    }
    ok(threw, 'serverName 含空格应被 schema 拒绝（证明 schema 真的在校验）');
  });

  // =========================================================================
  // ② 真 cordis 组合 + 真 mcp-client → 工具注册
  // =========================================================================
  group('② 真 cordis Context + 真 mcp-client 注册出 mcp__unreal__*');

  mock = await startMock({ logPath: obsLog });
  console.log(`        mock URL = ${mock.url}`);

  await checkAsync('组装真 Context（systemPrompt + tools 服务）', async () => {
    ctx = new cordis.Context();
    ctx.plugin(SystemPrompt, {
      includeHarnessIdentity: false,
      includeRuntimeContext: false,
    });
    ctx.plugin(ToolRuntime, { mode: 'native' });
    // 等两个服务就绪
    await waitFor('systemPrompt/tools 服务就绪', () => !!ctx.systemPrompt && !!ctx.tools);
    ok(typeof ctx.tools.register === 'function', 'ctx.tools.register 应可用');
    ok(typeof ctx.systemPrompt.section === 'function', 'ctx.systemPrompt.section 应可用');
  });

  await checkAsync('把真 mcp-client 插件装进 Context 并指向 mock', async () => {
    const resolved = mcp.Config(patchedConfig);
    // 只改 url 指向本次 mock 的随机端口；其余全部沿用 patch 里的生产配置
    const config = mcp.Config({ ...resolved, url: mock.url });
    ctx.plugin(mcp, config);
    console.log(`        已装载 mcp-client，serverName=${config.serverName} url=${config.url}`);
  });

  await checkAsync('mcp__unreal__list_toolsets / describe_toolset / call_tool 三个工具被注册', async () => {
    const expected = [
      'mcp__unreal__list_toolsets',
      'mcp__unreal__describe_toolset',
      'mcp__unreal__call_tool',
    ];
    await waitFor(
      `三个 mcp__unreal__* 工具注册完成`,
      () => {
        const view = ctx.tools.view(undefined);
        const names = [...view.visible.keys()];
        return expected.every((n) => names.includes(n)) ? names : false;
      },
      20_000,
    );
    const names = [...ctx.tools.view(undefined).visible.keys()];
    console.log(`        ctx.tools 可见工具 = ${JSON.stringify(names)}`);
    for (const n of expected) includes(names, n, 'ctx.tools 可见工具');
    // A6a：精确等于（排序后 deepEqual）
    eq(names.filter((n) => n.startsWith('mcp__unreal__')).sort(), [...expected].sort(), 'A6a 工具名精确匹配');
  });

  await check('只有这 3 个工具来自 unreal 命名空间（没有误注册真实工具）', () => {
    const names = [...ctx.tools.view(undefined).visible.keys()].filter((n) =>
      n.startsWith('mcp__unreal__'),
    );
    eq(names.sort(), [
      'mcp__unreal__call_tool',
      'mcp__unreal__describe_toolset',
      'mcp__unreal__list_toolsets',
    ], 'unreal 命名空间下的工具');
  });

  await check('工具 schema 带上了 mock 下发的 inputSchema 属性', () => {
    const view = ctx.tools.view(undefined).visible;
    const callTool = view.get('mcp__unreal__call_tool');
    ok(callTool, 'call_tool 定义应存在');
    const props = Object.keys(callTool.parameters?.properties || {});
    eq(props.sort(), ['arguments', 'tool_name', 'toolset_name'], 'call_tool.parameters.properties');
    const describe = view.get('mcp__unreal__describe_toolset');
    const dProps = Object.keys(describe.parameters?.properties || {});
    eq(dProps.sort(), ['tool_name', 'toolset_name'], 'describe_toolset.parameters.properties');
  });

  await check('每个注册工具都有 execute 函数与 output 契约（符合 ToolRuntime.register 要求）', () => {
    const view = ctx.tools.view(undefined).visible;
    for (const n of ['mcp__unreal__list_toolsets', 'mcp__unreal__describe_toolset', 'mcp__unreal__call_tool']) {
      const d = view.get(n);
      eq(typeof d.execute, 'function', `${n}.execute 类型`);
      ok(d.output && typeof d.output.render === 'function', `${n} 应有 output.render`);
      ok(d.output.schema !== undefined, `${n} 应有 output.schema`);
    }
  });

  // =========================================================================
  // ③ 端到端调用
  // =========================================================================
  group('③ 端到端：真的执行 call_tool 拿到 returnValue');

  const execCtx = () => ({ signal: new AbortController().signal });

  await checkAsync('执行 list_toolsets，能解析出 toolset 列表', async () => {
    const def = ctx.tools.view(undefined).visible.get('mcp__unreal__list_toolsets');
    const res = await def.execute({}, execCtx());
    ok(res && Array.isArray(res.content), '结果应有 content 数组');
    const text = res.content[0].text;
    const toolsets = JSON.parse(text);
    ok(Array.isArray(toolsets) && toolsets.length >= 2, '应解析出至少 2 个 toolset');
    console.log(`        list_toolsets → ${JSON.stringify(toolsets.map((t) => t.name))}`);
  });

  await checkAsync('执行 describe_toolset，能拿到 SceneTools 的工具 schema', async () => {
    const def = ctx.tools.view(undefined).visible.get('mcp__unreal__describe_toolset');
    const res = await def.execute(
      { toolset_name: 'editor_toolset.toolsets.scene.SceneTools' },
      execCtx(),
    );
    const tools = JSON.parse(res.content[0].text);
    const names = tools.map((t) => t.name).sort();
    eq(names, ['find_actors', 'get_current_level', 'spawn_actor'], 'SceneTools 工具名');
  });

  let callToolShape = null;

  await checkAsync('执行 call_tool（get_current_level）→ 解析出 returnValue', async () => {
    const def = ctx.tools.view(undefined).visible.get('mcp__unreal__call_tool');
    const res = await def.execute(
      {
        toolset_name: 'editor_toolset.toolsets.scene.SceneTools',
        tool_name: 'get_current_level',
        arguments: {},
      },
      execCtx(),
    );
    ok(res && Array.isArray(res.content), '结果应有 content 数组');
    const payload = JSON.parse(res.content[0].text);
    ok('returnValue' in payload, `文本块应是 {"returnValue": ...}，实际 ${Object.keys(payload)}`);
    eq(payload.returnValue.levelPath, '/Game/Maps/Main.Main', 'returnValue.levelPath');
    console.log(`        call_tool → returnValue = ${JSON.stringify(payload.returnValue)}`);

    // 归档返回形状，供下一条断言使用
    callToolShape = {
      keys: Object.keys(res),
      contentType: res.content[0].type,
      hasStructuredContent: 'structuredContent' in res,
      rawText: res.content[0].text,
      parsedReturnValue: payload.returnValue,
    };
  });

  await check('返回形状：content[0].type=text，UE 的 returnValue 只在 text 里，无 structuredContent', () => {
    // 实测（DSH mcp-client createExecutor）：
    //   const value = { content, ...(result.structuredContent !== undefined ? {structuredContent} : {}) }
    // UE 的 tools/call 只回文本内容块，不返回 structuredContent，
    // 所以 agent 侧必须对 content[0].text 做 JSON.parse 才能拿到 returnValue。
    // 这条事实直接决定 skill 里「怎么读返回值」的写法。
    ok(callToolShape, 'call_tool 返回形状样本缺失');
    eq(callToolShape.keys, ['content'], '返回对象顶层 keys');
    eq(callToolShape.contentType, 'text', 'content[0].type');
    ok(!callToolShape.hasStructuredContent, 'UE 的结果不应带 structuredContent');
    includes(callToolShape.rawText, 'returnValue', 'text 原始字符串');
    eq(callToolShape.parsedReturnValue.levelPath, '/Game/Maps/Main.Main', 'JSON.parse 后的 returnValue');
  });

  await checkAsync('执行 call_tool（find_actors，required 用 ""/[] 表达任意）→ 成功', async () => {
    const def = ctx.tools.view(undefined).visible.get('mcp__unreal__call_tool');
    const res = await def.execute(
      {
        toolset_name: 'editor_toolset.toolsets.scene.SceneTools',
        tool_name: 'find_actors',
        arguments: { name: '', tag: '', collision_channels: [] },
      },
      execCtx(),
    );
    const { returnValue } = JSON.parse(res.content[0].text);
    ok(Array.isArray(returnValue) && returnValue.length > 0, '应返回 actor 数组');
    ok(returnValue[0].refPath, '元素应带 refPath');
    console.log(`        find_actors → ${returnValue.length} 个 actor，refPath=${returnValue[0].refPath}`);
  });

  // =========================================================================
  // ④ 负面路径穿透真链路
  // =========================================================================
  group('④ 派发语义的负面路径（穿透真 mcp-client 链路）');

  /**
   * 重要：DSH 的 mcp-client 会把 MCP 的 isError 结果**转成抛异常**，而不是把
   * {isError:true} 原样返回给调用方。源码（dsh-mcp-client/lib/index.js createExecutor）：
   *     if (result.isError === true) throw new Error(text);
   * 所以这里断言的是 throw + 错误消息，而不是返回值上的 isError 字段。
   * 这同时说明：agent 侧看到的会是工具调用失败，需要按 skill 里的排障说明重试。
   */
  await checkAsync('全限定 tool_name 穿过真链路 → 抛错且消息含 Unknown tool', async () => {
    const def = ctx.tools.view(undefined).visible.get('mcp__unreal__call_tool');
    let err = null;
    try {
      await def.execute(
        {
          toolset_name: 'editor_toolset.toolsets.scene.SceneTools',
          tool_name: 'editor_toolset.toolsets.scene.SceneTools.get_current_level',
          arguments: {},
        },
        execCtx(),
      );
    } catch (e) {
      err = e;
    }
    ok(err, 'isError 结果应被 mcp-client 转成抛异常（实际却没有抛）');
    includes(err.message, 'Unknown tool', '抛出的错误消息');
    console.log(`        抛错消息: ${JSON.stringify(err.message)}`);
  });

  await checkAsync('缺 TOptional（CaptureViewport）→ 抛错且消息含 needs a default value', async () => {
    const def = ctx.tools.view(undefined).visible.get('mcp__unreal__call_tool');
    let err = null;
    try {
      await def.execute(
        {
          toolset_name: 'EditorToolset.EditorAppToolset',
          tool_name: 'CaptureViewport',
          arguments: { bShowUI: false },
        },
        execCtx(),
      );
    } catch (e) {
      err = e;
    }
    ok(err, 'isError 结果应被转成抛异常（实际却没有抛）');
    includes(err.message, 'needs a default value', '抛出的错误消息');
    console.log(`        抛错消息: ${JSON.stringify(err.message)}`);
  });

  // =========================================================================
  // ⑤ 真链路验收：mock 观测日志证明请求真的走过了 streamable-http + SSE
  // =========================================================================
  group('⑤ 线路证据：这些调用确实走了 streamable-http + SSE');

  await check('mock 观察到 tools/list 与多次 tools/call，且都带 session 头', () => {
    ok(existsSync(obsLog), '观测日志不存在');
    const obs = readFileSync(obsLog, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const list = obs.filter((o) => o.method === 'tools/list');
    const calls = obs.filter((o) => o.method === 'tools/call');
    ok(list.length >= 1, `应观察到 tools/list，实际 ${list.length}`);
    ok(calls.length >= 5, `应观察到 ≥5 次 tools/call（含负面路径），实际 ${calls.length}`);
    for (const c of calls) eq(c.responseContentType, 'text/event-stream', `${c.tool} content-type`);
    console.log(`        observations: ${obs.length} 条；tools/list=${list.length} tools/call=${calls.length}`);
    console.log(`        调用的派发工具: ${JSON.stringify([...new Set(calls.map((c) => c.tool))])}`);
  });

  await check('A7: 请求序列含 initialize → notifications/initialized → tools/list，且都带 session 头', () => {
    const obs = readFileSync(obsLog, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const seq = obs.map((o) => o.method);
    const iInit = seq.indexOf('initialize');
    const iNotif = seq.indexOf('notifications/initialized');
    const iList = seq.indexOf('tools/list');
    ok(iInit >= 0, `应观察到 initialize；实际序列 ${JSON.stringify(seq)}`);
    ok(iNotif > iInit, `notifications/initialized 应在 initialize 之后；实际序列 ${JSON.stringify(seq)}`);
    ok(iList > iNotif, `tools/list 应在 notifications/initialized 之后；实际序列 ${JSON.stringify(seq)}`);
    // 握手三件套都必须带 session 头（initialize 之后才会有，initialize 本身除外）
    for (const m of ['notifications/initialized', 'tools/list']) {
      const rec = obs.find((o) => o.method === m);
      ok(rec.sessionHeader, `${m} 必须带 mcp-session-id`);
    }
    const init = obs.find((o) => o.method === 'initialize');
    eq(init.status, 200, 'initialize status');
    ok(init.issuedSession, 'initialize 应签发 session');
    console.log(`        握手序列: ${JSON.stringify(seq.slice(0, 5))} …`);
  });

  await check('wire 上派发的始终是 3 个元工具（真实工具绝不直接出线）', () => {
    const obs = readFileSync(obsLog, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((o) => o.method === 'tools/call');
    const dispatched = new Set(obs.map((o) => o.tool));
    for (const t of dispatched) {
      ok(
        ['list_toolsets', 'describe_toolset', 'call_tool'].includes(t),
        `wire 上不应出现非元工具 ${t}`,
      );
    }
  });

  // =========================================================================
  // ⑤' 慢响应：证明 toolCallTimeoutMs 配置不是随便填的
  // =========================================================================
  group("⑤' 慢 tools/call（模拟 game thread 阻塞）不超时");

  /**
   * UE 的 tools/call 会阻塞到 game thread 执行完毕才发 SSE 帧，真实场景可能数秒。
   * 这里让 mock 延迟 2s 才发帧，断言在 patch 的 toolCallTimeoutMs=300000 下能正常等到结果。
   * 这同时证明「把 timeout 调大」这条配置是有实际意义的，而不是抄来的数字。
   */
  await checkAsync('mock 延迟 2s 回帧时，真链路仍能拿到结果（不超时）', async () => {
    const slowLog = join(workDir, 'obs-slow.jsonl');
    const slowMock = await startMock({
      logPath: slowLog,
      env: { MOCK_CALL_DELAY_MS: '2000' },
    });
    try {
      const ctxSlow = new cordis.Context();
      ctxSlow.plugin(SystemPrompt, {
        includeHarnessIdentity: false,
        includeRuntimeContext: false,
      });
      await sleep(150);
      ctxSlow.plugin(ToolRuntime, { mode: 'native' });
      await waitFor('慢响应 Context 服务就绪', () => !!ctxSlow.systemPrompt && !!ctxSlow.tools);

      // 用 patch 里的生产超时（300000），只把 url 换成本次 mock
      const resolved = mcp.Config(patchedConfig);
      const slowCfg = mcp.Config({ ...resolved, url: slowMock.url });
      ok(
        slowCfg.toolCallTimeoutMs >= 300_000,
        `本用例前提：toolCallTimeoutMs 应 ≥300000，实际 ${slowCfg.toolCallTimeoutMs}`,
      );
      ctxSlow.plugin(mcp, slowCfg);

      await waitFor(
        '慢响应 mock 上工具注册完成',
        () => {
          const names = [...ctxSlow.tools.view(undefined).visible.keys()];
          return names.includes('mcp__unreal__call_tool');
        },
        20_000,
      );

      const t0 = Date.now();
      const def = ctxSlow.tools.view(undefined).visible.get('mcp__unreal__call_tool');
      const res = await def.execute(
        {
          toolset_name: 'editor_toolset.toolsets.scene.SceneTools',
          tool_name: 'get_current_level',
          arguments: {},
        },
        { signal: new AbortController().signal },
      );
      const elapsed = Date.now() - t0;

      ok(res && Array.isArray(res.content), '结果应有 content 数组');
      const payload = JSON.parse(res.content[0].text);
      eq(payload.returnValue.levelPath, '/Game/Maps/Main.Main', 'returnValue.levelPath');
      ok(elapsed >= 1800, `应真的等满约 2s（证明慢响应被覆盖），实际 ${elapsed}ms`);
      ok(elapsed < 60_000, `不应异常久，实际 ${elapsed}ms`);
      console.log(
        `        慢响应调用耗时 ${elapsed}ms（mock 固定延迟 2000ms），timeout=${slowCfg.toolCallTimeoutMs}ms → 正常返回`,
      );

      await ctxSlow.dispose?.();
    } finally {
      await stopMock(slowMock);
    }
  });

  await checkAsync('对照组：timeout 设为 300ms 时同一慢调用会失败（证明 timeout 真的生效）', async () => {
    const slowLog2 = join(workDir, 'obs-slow2.jsonl');
    const slowMock2 = await startMock({
      logPath: slowLog2,
      env: { MOCK_CALL_DELAY_MS: '2000' },
    });
    try {
      const ctxT = new cordis.Context();
      ctxT.plugin(SystemPrompt, {
        includeHarnessIdentity: false,
        includeRuntimeContext: false,
      });
      await sleep(150);
      ctxT.plugin(ToolRuntime, { mode: 'native' });
      await waitFor('对照 Context 服务就绪', () => !!ctxT.systemPrompt && !!ctxT.tools);

      // 故意给一个远小于 2s 的超时
      const tightCfg = mcp.Config({
        ...mcp.Config(patchedConfig),
        url: slowMock2.url,
        toolCallTimeoutMs: 300,
      });
      ctxT.plugin(mcp, tightCfg);
      await waitFor(
        '对照 mock 上工具注册完成',
        () => {
          const names = [...ctxT.tools.view(undefined).visible.keys()];
          return names.includes('mcp__unreal__call_tool');
        },
        20_000,
      );

      const def = ctxT.tools.view(undefined).visible.get('mcp__unreal__call_tool');
      let err = null;
      const t0 = Date.now();
      try {
        await def.execute(
          {
            toolset_name: 'editor_toolset.toolsets.scene.SceneTools',
            tool_name: 'get_current_level',
            arguments: {},
          },
          { signal: new AbortController().signal },
        );
      } catch (e) {
        err = e;
      }
      const elapsed = Date.now() - t0;
      ok(err, `timeout=300ms 时 2s 的慢调用应失败，实际却成功了（耗时 ${elapsed}ms）`);
      ok(elapsed < 1800, `应在 2s 之前就因超时失败，实际 ${elapsed}ms`);
      console.log(`        对照组在 ${elapsed}ms 处超时失败（预期），错误: ${err.message.slice(0, 90)}`);
      await ctxT.dispose?.();
    } finally {
      await stopMock(slowMock2);
    }
  });

  // =========================================================================
  // ⑥ 断线重连不炸（failOnStartupError:false 的真实行为）
  // =========================================================================
  group('⑥ 连接失败不阻断启动（failOnStartupError:false）');

  await checkAsync('指向无人监听的端口时，插件加载不抛（按 backoff 重连）', async () => {
    // 用一个大概率没人监听的临时端口
    const deadPort = 19987;
    const ctx2 = new cordis.Context();
    ctx2.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false });
    ctx2.plugin(ToolRuntime, { mode: 'native' });
    await waitFor('第二个 Context 服务就绪', () => !!ctx2.systemPrompt && !!ctx2.tools);
    const cfg = mcp.Config({
      ...mcp.Config(patchedConfig),
      url: `http://127.0.0.1:${deadPort}/mcp`,
      reconnect: { enabled: true, initialDelayMs: 100, maxDelayMs: 200, maxAttempts: 3 },
    });

    let threw = null;
    try {
      ctx2.plugin(mcp, cfg);
      // 给插件一点时间走完首次失败
      await sleep(1200);
    } catch (e) {
      threw = e;
    }
    ok(!threw, `failOnStartupError=false 时不应抛，实际: ${threw && threw.message}`);
    // 关键：工具没注册上，但进程/上下文都还活着
    const names = [...ctx2.tools.view(undefined).visible.keys()];
    eq(names.filter((n) => n.startsWith('mcp__unreal__')), [], '连不上时不应注册工具');
    console.log(`        连不上时可见工具数 = ${names.length}（无 mcp__unreal__*），未抛异常`);
    await ctx2.dispose?.();
  });

  // =========================================================================
  // ⑦ UNREAL_MCP_PORT 环境变量真的能覆盖 patch 里的 url 表达式
  // =========================================================================
  group('⑦ UNREAL_MCP_PORT 覆盖 patch 的 !!js url 表达式');

  await check('不设环境变量 → 回落 8000；设了 → 用该端口（表达式真的被求值，不是文本匹配）', () => {
    const m = patchSource.match(/url:\s*!!js\s+'([^']+)'/);
    ok(m, 'patch 中应存在 url: !!js \'...\' 形式');
    const expr = m[1];
    const evalWith = (val) => {
      const saved = process.env.UNREAL_MCP_PORT;
      if (val === undefined) delete process.env.UNREAL_MCP_PORT;
      else process.env.UNREAL_MCP_PORT = val;
      try {
        return new Function('process', 'return (' + expr + ');')(process);
      } finally {
        if (saved === undefined) delete process.env.UNREAL_MCP_PORT;
        else process.env.UNREAL_MCP_PORT = saved;
      }
    };
    eq(evalWith(undefined), 'http://127.0.0.1:8000/mcp', '未设 UNREAL_MCP_PORT 时的 url');
    eq(evalWith('8123'), 'http://127.0.0.1:8123/mcp', 'UNREAL_MCP_PORT=8123 时的 url');
    eq(evalWith('9001'), 'http://127.0.0.1:9001/mcp', 'UNREAL_MCP_PORT=9001 时的 url');
    console.log(`        表达式求值：默认 8000，覆盖 8123 / 9001 均正确`);
  });

  // =========================================================================
  // ⑧ 编辑器后启动：mcp-client 自动重连并注册工具（真 server 事后出现）
  // =========================================================================
  group('⑧ 编辑器后启动：真 server 事后出现 → 自动重连，无需重启 DSH');

  await checkAsync('先指向空端口（无工具）→ 起 mock → 自动拿到 3 个工具并真调用成功', async () => {
    const freePort = await getFreePort();
    const ctx3 = new cordis.Context();
    ctx3.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false });
    await sleep(150);
    ctx3.plugin(ToolRuntime, { mode: 'native' });
    await waitFor('重连用例 Context 服务就绪', () => !!ctx3.systemPrompt && !!ctx3.tools);

    ctx3.plugin(
      mcp,
      mcp.Config({
        ...mcp.Config(patchedConfig),
        url: `http://127.0.0.1:${freePort}/mcp`,
        // 生产配置是 1000ms 起步 / 30s 封顶；这里只为加快测试而缩小，语义一致
        reconnect: { enabled: true, initialDelayMs: 200, maxDelayMs: 800, maxAttempts: 1000 },
      }),
    );

    await sleep(1500);
    const before = [...ctx3.tools.view(undefined).visible.keys()].filter((n) => n.startsWith('mcp__unreal__'));
    eq(before, [], '服务未起时不应注册任何 mcp__unreal__* 工具');
    console.log(`        端口 ${freePort} 上没人监听：工具数 0，插件未抛异常`);

    // 「编辑器后启动」= mock 在 DSH 已经空转过若干次重连之后才出现
    const lateMock = await startMock({ port: freePort });
    try {
      await waitFor(
        '自动重连后 3 个工具注册完成',
        () => [...ctx3.tools.view(undefined).visible.keys()].filter((n) => n.startsWith('mcp__unreal__')).length === 3,
        30_000,
      );
      const names = [...ctx3.tools.view(undefined).visible.keys()]
        .filter((n) => n.startsWith('mcp__unreal__'))
        .sort();
      eq(
        names,
        ['mcp__unreal__call_tool', 'mcp__unreal__describe_toolset', 'mcp__unreal__list_toolsets'],
        '重连后注册的工具名',
      );

      // 真调一次，证明不是只把名字注册上了
      const def = ctx3.tools.view(undefined).visible.get('mcp__unreal__list_toolsets');
      const res = await def.execute({}, { signal: new AbortController().signal });
      const text = String(res?.content?.[0]?.text || '');
      ok(text.length > 0, '重连后真调用 list_toolsets 应返回非空文本');
      console.log(`        重连后 list_toolsets 返回 ${text.length} 字符`);
    } finally {
      await ctx3.dispose?.();
      await stopMock(lateMock);
    }
  });
} catch (e) {
  failed++;
  failures.push({ group: '外层', label: '未捕获异常', msg: e?.stack || String(e) });
  console.log(`\n[外层异常] ${e?.stack || e}`);
} finally {
  try {
    if (ctx) await ctx.dispose?.();
  } catch {}
  await stopMock(mock);
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {}
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
console.log('\n══════════════════════════════════════════');
console.log(`integration: ${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  • [${f.group}] ${f.label}\n    ${f.msg.split('\n')[0]}`);
} else {
  console.log('结果: PASS —— 真 cordis + 真 mcp-client 能把 UE 工具注册成 mcp__unreal__* 并调用');
}

// cordis / MCP SDK 可能留下仍存活的 handle（定时器、socket），不能让进程挂住。
// 显式退出并给出正确的退出码。
process.exit(failed ? 1 : 0);
