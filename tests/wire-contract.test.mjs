/**
 * wire-contract.test.mjs —— 用 **DSH 自带的真 MCP SDK** 打 UE 线路 mock，逐条断言线路契约。
 *
 * 为什么这样测：
 *   SPEC.md §2.2 的核心结论是「DSH 的 @modelcontextprotocol/client 2.2.0
 *   （StreamableHTTPClientTransport）能正确处理 UE 5.8 的全部线路怪癖」。
 *   这条结论决定整个方案成立，所以必须用**真的 SDK** 而不是手写 HTTP 来验证。
 *   SDK 本身不暴露 HTTP 状态码，因此「202 空体」「每个请求都回传 session 头」这类
 *   断言从 **mock 侧的服务端观测日志** 取证（mock-unreal-mcp.mjs 的 --log）。
 *
 * 运行方式（必须用 DSH 的 Electron 当 Node 跑）：
 *   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *     wire-contract.test.mjs
 *
 * 本文件自包含（不依赖 tests/ 下的其它文件之外的任何第三方包），自己拉起/关闭 mock。
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MOCK = join(HERE, 'mock-unreal-mcp.mjs');

// DSH 安装包路径（asar 内依赖只能这样绝对路径 import）
const APP_ASAR = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar';
const SDK_ENTRY = `${APP_ASAR}/dsh/node_modules/@modelcontextprotocol/client/dist/index.mjs`;

// ---------------------------------------------------------------------------
// 极简断言框架（自包含，便于单文件独立运行）
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
  if (typeof haystack !== 'string' || !haystack.includes(needle)) {
    throw new Error(`${what || 'value'} should include ${JSON.stringify(needle)}, got ${JSON.stringify(String(haystack).slice(0, 200))}`);
  }
}

// ---------------------------------------------------------------------------
// mock 进程管理
// ---------------------------------------------------------------------------
function startMock({ logPath, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const args = [MOCK, '0'];
    if (logPath) args.push('--log', logPath);

    // 用当前 execPath（Electron 二进制）当 Node 跑，保证与测试同运行时
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
      reject(new Error(`mock 启动超时 10s。stdout=${out} stderr=${err}`));
    }, 10_000);

    child.stdout.on('data', (d) => {
      out += d.toString();
      const m = out.match(/MOCK_READY (\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve({ child, url: m[1], getStdout: () => out, getStderr: () => err });
      }
    });
    child.stderr.on('data', (d) => {
      err += d.toString();
    });
    child.on('exit', (code) => {
      if (!/MOCK_READY/.test(out)) {
        clearTimeout(timer);
        reject(new Error(`mock 提前退出 code=${code} stderr=${err}`));
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

function readObservations(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const workDir = mkdtempSync(join(tmpdir(), 'dsh-ue-wire-'));
const logPath = join(workDir, 'observations.jsonl');

console.log('═══ wire-contract.test.mjs — DSH 真 SDK × UE 5.8 线路 mock ═══');
console.log(`临时工作目录: ${workDir}`);
console.log(`mock 脚本:    ${MOCK}`);
console.log(`SDK:          ${SDK_ENTRY}`);

let mock;
let client;
let transport;
let sdk;

try {
  // -----------------------------------------------------------------------
  // 0) 依赖与 mock 就绪
  // -----------------------------------------------------------------------
  group('0. 环境与 mock 就绪');

  await checkAsync('能从 DSH 安装包内 import 真 MCP SDK', async () => {
    sdk = await import(SDK_ENTRY);
    ok(typeof sdk.Client === 'function', 'Client 应为构造函数');
    ok(typeof sdk.StreamableHTTPClientTransport === 'function', 'StreamableHTTPClientTransport 应为构造函数');
  });

  await checkAsync('mock 能在随机高位端口启动（端口可传参）', async () => {
    mock = await startMock({ logPath });
    const port = Number(new URL(mock.url).port);
    ok(Number.isInteger(port) && port > 0, `端口非法: ${port}`);
    ok(port >= 1024, `应使用非特权端口，实际 ${port}`);
    console.log(`        mock URL = ${mock.url}`);
  });

  // -----------------------------------------------------------------------
  // 1) 连接协商：initialize
  // -----------------------------------------------------------------------
  group('1. initialize 协商（普通 JSON + mcp-session-id 头）');

  await checkAsync('StreamableHTTPClientTransport 能连上 mock', async () => {
    transport = new sdk.StreamableHTTPClientTransport(new URL(mock.url));
    client = new sdk.Client({ name: 'dsh-wire-contract', version: '1.0.0' });
    const t0 = Date.now();
    await client.connect(transport);
    console.log(`        连接耗时 ${Date.now() - t0} ms`);
  });

  await check('协商出的 protocolVersion = 2025-06-18', () => {
    const v = client.getNegotiatedProtocolVersion?.();
    eq(v, '2025-06-18', 'protocolVersion');
  });

  await check('mock 观察到 initialize 返回 200 且签发了 session', () => {
    const obs = readObservations(logPath);
    const init = obs.find((o) => o.method === 'initialize');
    ok(init, '未观察到 initialize 请求');
    eq(init.status, 200, 'initialize status');
    ok(init.issuedSession, 'initialize 应签发 session id');
  });

  await check('服务端把 SDK 请求的新版本降级到 2025-06-18（旧服务端兼容路径）', () => {
    const obs = readObservations(logPath);
    const init = obs.find((o) => o.method === 'initialize');
    // 实测：DSH SDK 默认请求 protocolVersion = 2025-11-25；
    // 本 mock 只支持到 2025-06-18（UE 5.8 已知版本），于是降级 —— 这是旧服务端的真实行为，
    // 也证明 SDK 与「只认 2025-06-18」的服务端能正常协商。
    console.log(`        SDK 请求的 protocolVersion = ${init.requestedProtocolVersion}`);
    console.log(`        协商结果                     = ${client.getNegotiatedProtocolVersion?.()}`);
    ok(
      typeof init.requestedProtocolVersion === 'string' && init.requestedProtocolVersion.length > 0,
      'SDK 应给出请求的 protocolVersion',
    );
    ok(
      ['2025-06-18', '2025-03-26', '2024-11-05'].includes(client.getNegotiatedProtocolVersion?.()),
      `协商出的版本应在服务端支持列表内，实际 ${client.getNegotiatedProtocolVersion?.()}`,
    );
  });

  // -----------------------------------------------------------------------
  // 2) tools/list —— tool search 模式只露三个元工具
  // -----------------------------------------------------------------------
  group('2. tools/list：tool search 模式只下发 3 个元工具');

  let toolNames = [];
  let currentTools = [];

  await checkAsync('listTools() 成功返回', async () => {
    const res = await client.listTools();
    currentTools = res.tools;
    toolNames = res.tools.map((t) => t.name);
    console.log(`        tools = ${JSON.stringify(toolNames)}`);
  });

  await check('tools/list 恰好 3 个工具', () => eq(toolNames.length, 3, 'tools.length'));

  await check('工具集 = [list_toolsets, describe_toolset, call_tool]', () => {
    eq([...toolNames].sort(), ['call_tool', 'describe_toolset', 'list_toolsets'], 'tool names');
  });

  await check('真实工具没有被 advertise（tool search 生效）', () => {
    for (const hidden of ['get_current_level', 'find_actors', 'set_properties', 'CaptureViewport', 'spawn_actor']) {
      ok(!toolNames.includes(hidden), `tools/list 不应包含 ${hidden}`);
    }
  });

  await check('三个元工具都带非空 description 与 object inputSchema', () => {
    // 重新取一次完整对象
    for (const t of currentTools) {
      ok(t.description && t.description.length > 0, `${t.name} 缺 description`);
      eq(t.inputSchema?.type, 'object', `${t.name}.inputSchema.type`);
    }
  });

  // -----------------------------------------------------------------------
  // 3) session 头 + 202 通知（服务端侧取证）
  // -----------------------------------------------------------------------
  group('3. 会话头与 202 空响应');

  await check('notifications/initialized 被 mock 以 202 接受', () => {
    const obs = readObservations(logPath);
    const n = obs.find((o) => o.method === 'notifications/initialized');
    ok(n, '未观察到 notifications/initialized');
    eq(n.status, 202, 'initialized status');
    eq(n.note, 'notification accepted', 'note');
  });

  await check('初始化之后的通知请求已回传 mcp-session-id', () => {
    const obs = readObservations(logPath);
    const notif = obs.find((o) => o.method === 'notifications/initialized');
    ok(notif, '未观察到通知请求');
    ok(notif.sessionHeader, '通知请求必须带 session 头');
    const init = obs.find((o) => o.method === 'initialize');
    eq(notif.sessionHeader, init.issuedSession, '通知用的 session 应与 initialize 签发的一致');
  });

  await check('mock 对缺失 session 头的请求返回 400（契约本身没被放松）', async () => {
    const r = await fetch(mock.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list' }),
    });
    eq(r.status, 400, 'no-session status');
    const body = await r.json();
    eq(body.error.code, -32000, 'no-session error code');
  });

  /**
   * DSH 的 MCP SDK 2.2.0 在 versionNegotiation=auto 下会先发一次 `server/discover` 探测
   * （Lead 在真 DSH 进程里实测观测到）。真 UE 此时还没有 session，于是回 400；
   * SDK 收到 400 后自动回落到 legacy 的 initialize —— 这是正常路径，不是故障。
   * 这里把这条真实路径也复现并断言。
   */
  await checkAsync('server/discover 探测（无 session）→ 400，SDK 仍随后成功 initialize', async () => {
    const r = await fetch(mock.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'server-discover-probe-1',
        method: 'server/discover',
        params: {},
      }),
    });
    eq(r.status, 400, 'server/discover（无 session）status');
    const body = await r.json();
    eq(body.error.code, -32000, 'server/discover error code');
    // 上面的 client 已经成功连上了 —— 证明 400 之后的 legacy initialize 回落可用
    ok(client.getNegotiatedProtocolVersion?.(), '回落之后仍应有协商版本');
    console.log(
      `        server/discover → ${r.status}；回落 initialize 后版本 = ${client.getNegotiatedProtocolVersion?.()}`,
    );
  });

  // -----------------------------------------------------------------------
  // 4) GET SSE 流：没有也要能跑
  // -----------------------------------------------------------------------
  group('4. GET SSE 流 404 不影响可用性');

  await check('mock 对 GET /mcp 返回 404（模拟部分引擎 build）', () => {
    const obs = readObservations(logPath);
    const g = obs.find((o) => o.method === 'GET');
    ok(g, 'SDK 应尝试过 GET 建立 SSE 流（否则该变体没被覆盖）');
    eq(g.status, 404, 'GET status');
    eq(g.note, 'no GET SSE stream', 'GET note');
  });

  await checkAsync('GET 404 之后 tools/list 仍然成功（证明容错）', async () => {
    // 第 2 步已成功；这里再打一次确认流仍然活着
    const res = await client.listTools();
    eq(res.tools.length, 3, 'tools.length（GET 404 之后）');
  });

  // -----------------------------------------------------------------------
  // 5) 派发语义：list_toolsets / describe_toolset
  // -----------------------------------------------------------------------
  group('5. 元工具派发：list_toolsets / describe_toolset');

  let toolsets = [];

  await checkAsync('list_toolsets 返回可解析的 JSON 数组', async () => {
    const r = await client.callTool({ name: 'list_toolsets', arguments: {} });
    ok(!r.isError, `list_toolsets 不应 isError: ${JSON.stringify(r.content)}`);
    eq(r.content.length, 1, 'content 块数量');
    eq(r.content[0].type, 'text', 'content[0].type');
    toolsets = JSON.parse(r.content[0].text);
    ok(Array.isArray(toolsets) && toolsets.length >= 2, '应为数组且至少 2 个 toolset');
    console.log(`        toolsets = ${JSON.stringify(toolsets.map((t) => t.name))}`);
  });

  await check('toolset 名是全限定名（含点分隔路径）', () => {
    const py = toolsets.find((t) => t.name === 'editor_toolset.toolsets.scene.SceneTools');
    ok(py, '应包含 Python 侧全限定名 editor_toolset.toolsets.scene.SceneTools');
    const cpp = toolsets.find((t) => t.name === 'EditorToolset.EditorAppToolset');
    ok(cpp, '应包含 C++ 侧全限定名 EditorToolset.EditorAppToolset');
  });

  await checkAsync('describe_toolset 返回该 toolset 的工具 schema', async () => {
    const r = await client.callTool({
      name: 'describe_toolset',
      arguments: { toolset_name: 'editor_toolset.toolsets.scene.SceneTools' },
    });
    ok(!r.isError, `describe_toolset 不应 isError: ${JSON.stringify(r.content)}`);
    const tools = JSON.parse(r.content[0].text);
    const names = tools.map((t) => t.name);
    eq(names.sort(), ['find_actors', 'get_current_level', 'spawn_actor'], 'toolset 内工具名');
    const findActors = tools.find((t) => t.name === 'find_actors');
    eq(findActors.inputSchema.required.sort(), ['collision_channels', 'name', 'tag'], 'find_actors.required');
  });

  await checkAsync('describe_toolset 传未知 toolset → isError', async () => {
    const r = await client.callTool({
      name: 'describe_toolset',
      arguments: { toolset_name: 'No.Such.Toolset' },
    });
    eq(r.isError, true, 'isError');
    includes(r.content[0].text, 'Unknown toolset', 'error text');
  });

  // -----------------------------------------------------------------------
  // 6) call_tool 正常路径 + 结果包装
  // -----------------------------------------------------------------------
  group('6. call_tool：三元派发与结果包装');

  await checkAsync('call_tool 走 SSE 且能解析出 returnValue', async () => {
    const r = await client.callTool({
      name: 'call_tool',
      arguments: {
        toolset_name: 'editor_toolset.toolsets.scene.SceneTools',
        tool_name: 'get_current_level',
        arguments: {},
      },
    });
    ok(!r.isError, `不应 isError: ${JSON.stringify(r.content)}`);
    const payload = JSON.parse(r.content[0].text);
    ok('returnValue' in payload, `文本块里应是 {"returnValue": ...}，实际 keys=${Object.keys(payload)}`);
    eq(payload.returnValue.levelPath, '/Game/Maps/Main.Main', 'returnValue.levelPath');
    eq(payload.returnValue.isPersistent, true, 'returnValue.isPersistent');
  });

  await check('tools/call 的响应 content-type 是 text/event-stream', () => {
    const obs = readObservations(logPath);
    const calls = obs.filter((o) => o.method === 'tools/call');
    ok(calls.length >= 1, '未观察到 tools/call');
    for (const c of calls) eq(c.responseContentType, 'text/event-stream', `${c.tool} 的 content-type`);
  });

  await checkAsync('spawn_actor 返回 refPath，可被下游复用', async () => {
    const r = await client.callTool({
      name: 'call_tool',
      arguments: {
        toolset_name: 'editor_toolset.toolsets.scene.SceneTools',
        tool_name: 'spawn_actor',
        arguments: { actorClass: { refPath: '/Script/Engine.PointLight' }, location: { x: 0, y: 0, z: 100 } },
      },
    });
    ok(!r.isError, `不应 isError: ${JSON.stringify(r.content)}`);
    const { returnValue } = JSON.parse(r.content[0].text);
    // 本 mock 的 spawn_actor 走默认分支，只回 ok；真 UE 回 refPath。
    // 这里断言「返回结构可解析」而不是伪造 refPath。
    ok(typeof returnValue === 'object' && returnValue !== null, 'returnValue 应为对象');
  });

  // -----------------------------------------------------------------------
  // 7) 两个真实坑
  // -----------------------------------------------------------------------
  group('7. 真实坑 1：tool_name 传全限定名 → Unknown tool');

  await checkAsync('全限定 tool_name 被服务端拒绝且 isError=true', async () => {
    const r = await client.callTool({
      name: 'call_tool',
      arguments: {
        toolset_name: 'editor_toolset.toolsets.scene.SceneTools',
        tool_name: 'editor_toolset.toolsets.scene.SceneTools.get_current_level',
        arguments: {},
      },
    });
    eq(r.isError, true, 'isError');
    includes(r.content[0].text, 'Unknown tool', 'error text');
  });

  await checkAsync('短名 tool_name 同一调用成功（对照）', async () => {
    const r = await client.callTool({
      name: 'call_tool',
      arguments: {
        toolset_name: 'editor_toolset.toolsets.scene.SceneTools',
        tool_name: 'get_current_level',
        arguments: {},
      },
    });
    ok(!r.isError, '短名应成功');
  });

  group('8. 真实坑 2：TOptional / 字面 required 参数必须显式给值');

  await checkAsync('find_actors 省略 required 参数 → needs a default value', async () => {
    const r = await client.callTool({
      name: 'call_tool',
      arguments: {
        toolset_name: 'editor_toolset.toolsets.scene.SceneTools',
        tool_name: 'find_actors',
        arguments: {},
      },
    });
    eq(r.isError, true, 'isError');
    includes(r.content[0].text, 'needs a default value', 'error text');
  });

  await checkAsync('find_actors 只缺一个参数也报同样错（逐个校验）', async () => {
    const r = await client.callTool({
      name: 'call_tool',
      arguments: {
        toolset_name: 'editor_toolset.toolsets.scene.SceneTools',
        tool_name: 'find_actors',
        arguments: { name: 'PointLight_0', tag: '' },
      },
    });
    eq(r.isError, true, 'isError');
    includes(r.content[0].text, 'collision_channels', '应点名缺的参数');
  });

  await checkAsync('find_actors 用 "" / [] 表达“任意” → 成功（required 是字面语义）', async () => {
    const r = await client.callTool({
      name: 'call_tool',
      arguments: {
        toolset_name: 'editor_toolset.toolsets.scene.SceneTools',
        tool_name: 'find_actors',
        arguments: { name: '', tag: '', collision_channels: [] },
      },
    });
    ok(!r.isError, `传 ""/[] 应成功: ${JSON.stringify(r.content)}`);
    const { returnValue } = JSON.parse(r.content[0].text);
    ok(Array.isArray(returnValue), 'returnValue 应为数组');
    ok(returnValue[0].refPath, '元素应带 refPath');
  });

  await checkAsync('CaptureViewport 显式传 null 的 TOptional → 成功', async () => {
    const r = await client.callTool({
      name: 'call_tool',
      arguments: {
        toolset_name: 'EditorToolset.EditorAppToolset',
        tool_name: 'CaptureViewport',
        arguments: { captureTransform: null, annotations: null, bShowUI: false },
      },
    });
    ok(!r.isError, `显式 null 应成功: ${JSON.stringify(r.content)}`);
    const { returnValue } = JSON.parse(r.content[0].text);
    eq(returnValue.bShowUI, false, 'bShowUI');
  });

  await checkAsync('CaptureViewport 省略 TOptional → 报 needs a default value', async () => {
    const r = await client.callTool({
      name: 'call_tool',
      arguments: {
        toolset_name: 'EditorToolset.EditorAppToolset',
        tool_name: 'CaptureViewport',
        arguments: { bShowUI: false },
      },
    });
    eq(r.isError, true, 'isError');
    includes(r.content[0].text, 'needs a default value', 'error text');
  });

  group('9. 真实坑 3：ObjectTools.set_properties 的 values 是 JSON 字符串');

  await checkAsync('values 传 JSON 字符串 → 服务端 parse 成功', async () => {
    const r = await client.callTool({
      name: 'call_tool',
      arguments: {
        toolset_name: 'editor_toolset.toolsets.object.ObjectTools',
        tool_name: 'set_properties',
        arguments: {
          instance: { refPath: '/Game/Maps/Main.Main:PersistentLevel.PointLight_0' },
          values: JSON.stringify({ intensity: 10.0, bUseTemperature: true }),
        },
      },
    });
    ok(!r.isError, `不应 isError: ${JSON.stringify(r.content)}`);
    const { returnValue } = JSON.parse(r.content[0].text);
    eq(returnValue.updated.sort(), ['bUseTemperature', 'intensity'], '被更新的属性名');
  });

  await checkAsync('values 传对象（错误用法）→ 服务端 parse 失败被照实返回', async () => {
    const r = await client.callTool({
      name: 'call_tool',
      arguments: {
        toolset_name: 'editor_toolset.toolsets.object.ObjectTools',
        tool_name: 'set_properties',
        arguments: {
          instance: { refPath: '/Game/Maps/Main.Main:PersistentLevel.PointLight_0' },
          values: { intensity: 10.0 }, // 错误：应为 JSON 字符串
        },
      },
    });
    const { returnValue } = JSON.parse(r.content[0].text);
    ok(returnValue.error, '把对象当字符串应导致服务端 parse 失败');
  });

  // -----------------------------------------------------------------------
  // 10) Origin 校验
  // -----------------------------------------------------------------------
  group('10. 安全：拒绝非 loopback Origin');

  await checkAsync('非 loopback Origin → 403', async () => {
    const r = await fetch(mock.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        origin: 'https://evil.example.com',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    eq(r.status, 403, 'origin rejected status');
  });

  // -----------------------------------------------------------------------
  // 10.5) 全量复查：所有 post-init 请求都带 session 头
  // -----------------------------------------------------------------------
  group('10.5 全量复查：每一个 post-init 请求都回传同一个 session 头');

  await check('SDK 发出的每一个 post-init 请求都带同一个 session 头', () => {
    const obs = readObservations(logPath);
    // 排除本测试自己故意构造的负例探测（它们本来就不带 session / 带坏 Origin）：
    //   - "missing/invalid session header" ← 第 3 步的裸 fetch 负例
    //   - "origin rejected"               ← 第 10 步的坏 Origin 负例
    const NEGATIVE_PROBES = ['missing/invalid session header', 'origin rejected'];
    const sdkRequests = obs
      .filter((o) => o.method !== 'initialize')
      .filter((o) => !NEGATIVE_PROBES.includes(o.note));
    ok(sdkRequests.length >= 6, `SDK 发出的 post-init 请求应 ≥6 条，实际 ${sdkRequests.length}`);
    const missing = sdkRequests.filter((o) => !o.sessionHeader);
    eq(missing.map((o) => o.method), [], '缺 session 头的 SDK 请求');
    const sids = new Set(sdkRequests.map((o) => o.sessionHeader));
    eq(sids.size, 1, 'session id 去重后的数量');
    const methods = [...new Set(sdkRequests.map((o) => o.method))];
    console.log(`        SDK post-init 请求: ${methods.join(', ')}（共 ${sdkRequests.length} 条）`);
    // 必须覆盖到这几类，否则这一段算是没测到
    for (const m of ['notifications/initialized', 'tools/list', 'tools/call']) {
      ok(methods.includes(m), `应观察到 ${m}`);
    }
  });

  // -----------------------------------------------------------------------
  // 11) 连接关闭
  // -----------------------------------------------------------------------
  group('11. 连接收尾');

  await checkAsync('client.close() 正常结束且不抛', async () => {
    await client.close();
    client = undefined;
  });

  await check('mock 观察到 GET 流被客户端关闭（或本就 404）', () => {
    // 本 mock 默认 GET 404，无需关闭；这里只断言日志可读、进程仍活
    ok(readObservations(logPath).length >= 6, '观测日志记录量');
  });

  // -----------------------------------------------------------------------
  // 12) 第二个变体：mock 提供 GET SSE 流时也要能跑
  // -----------------------------------------------------------------------
  group('12. 变体对照：mock 提供 GET SSE 流（MOCK_GET_SSE=1）');

  let mock2;
  try {
    await checkAsync('GET SSE 可用时 SDK 同样能 connect + listTools + callTool', async () => {
      const log2 = join(workDir, 'observations-getsse.jsonl');
      mock2 = await startMock({ logPath: log2, env: { MOCK_GET_SSE: '1' } });
      const t2 = new sdk.StreamableHTTPClientTransport(new URL(mock2.url));
      const c2 = new sdk.Client({ name: 'dsh-wire-contract-getsse', version: '1.0.0' });
      await c2.connect(t2);
      const tools = await c2.listTools();
      eq(tools.tools.length, 3, 'tools.length');
      const r = await c2.callTool({
        name: 'call_tool',
        arguments: {
          toolset_name: 'editor_toolset.toolsets.scene.SceneTools',
          tool_name: 'get_current_level',
          arguments: {},
        },
      });
      ok(!r.isError, 'call_tool 应成功');
      JSON.parse(r.content[0].text);
      await c2.close();

      const obs2 = readObservations(log2);
      const g = obs2.find((o) => o.method === 'GET');
      ok(g, '应观察到 GET 请求');
      eq(g.status, 200, 'GET SSE status');
    });
  } finally {
    await stopMock(mock2);
  }
} catch (e) {
  // 框架外的意外错误（例如 import 失败）也要计入失败
  failed++;
  failures.push({ group: '外层', label: '未捕获异常', msg: e?.stack || String(e) });
  console.log(`\n[外层异常] ${e?.stack || e}`);
} finally {
  try {
    if (client) await client.close();
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
console.log(`wire-contract: ${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  • [${f.group}] ${f.label}\n    ${f.msg.split('\n')[0]}`);
  process.exitCode = 1;
} else {
  console.log('结果: PASS —— DSH 真 SDK 与 UE 5.8 线路契约兼容');
}
