/**
 * mock-unreal-mcp.mjs —— UE 5.8 内嵌 MCP Server 的线路级 mock（无需真 Unreal Engine）。
 *
 * 为什么需要它：本机没有 UE 5.8 引擎二进制，无法对真编辑器做验证。本 mock 只复刻
 * **线路协议与派发语义**（不模拟编辑器行为），用来验证 DSH 侧的 MCP 客户端与插件契约。
 *
 * 复刻的线路怪癖（来源：SPEC.md §2.1、逆向报告 §3.1 / §3.3）：
 *   1. initialize            → 普通 JSON 响应 + `mcp-session-id` 响应头
 *   2. 后续请求缺有效 session → 400（JSON-RPC error -32000）
 *   3. notifications/initialized → 202，空 body
 *   4. tools/list            → 普通 JSON，且默认（bEnableToolSearch=true）只下发 3 个元工具
 *   5. tools/call            → **text/event-stream**，`event: message` + `data: <jsonrpc>` 帧
 *   6. GET /mcp              → **404**（模拟不提供 GET SSE 流的部分引擎 build）
 *   7. 非 loopback Origin     → 403
 *   8. call_tool：tool_name 传全限定名 → "Unknown tool"
 *   9. call_tool：TOptional 参数省略 → `input param "X" needs a default value`
 *  10. call_tool：schema 的 required 是字面语义（"任意"要传 "" / []）
 *  11. 结果包装：文本内容块里是 {"returnValue": ...}
 *  12. **未知 session 的 POST 一律 400** —— 这条很关键：DSH 的 MCP SDK 2.2.0
 *      （versionNegotiation: auto）在 initialize 之前会先发一次 `server/discover` 探测，
 *      UE 服务端不认识这个 method + 此时也还没有 session，于是回 400；
 *      SDK 收到 400 后**自动回落到 legacy initialize**，这是正常路径，不是故障。
 *      要让这条真实路径可复现，mock 必须像 UE 一样对「无有效 session 的 POST」回 400。
 *
 * 另外提供「服务端观测日志」：每个请求的实际状态码 / content-type / session 头 /
 * Accept 都会写进 JSONL 日志文件。MCP 客户端 SDK 不暴露 HTTP 状态码，所以
 * 「202 空体」「每请求回传 session 头」这类断言只能从服务端侧取证。
 *
 * 用法：
 *   ELECTRON_RUN_AS_NODE=1 "<dsh-node>" mock-unreal-mcp.mjs [port] [--log <path>]
 *   - port 省略或 0 → 监听临时端口（推荐，避免端口冲突）
 *   - --log <path>  → 以 JSONL 追加写请求观测记录
 * 就绪时 stdout 打印一行：MOCK_READY http://127.0.0.1:<port>/mcp
 * 环境变量：
 *   MOCK_GET_SSE=1          提供 GET SSE 流（默认 404，对应多数引擎 build）
 *   MOCK_CALL_DELAY_MS=N    tools/call 延迟 N ms 再发帧（模拟 game thread 阻塞）
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
let PORT = 0;
let LOG_PATH = process.env.MOCK_LOG || '';
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--log') {
    LOG_PATH = argv[++i] || '';
  } else if (a === '--port') {
    PORT = Number(argv[++i] || 0);
  } else if (/^\d+$/.test(a)) {
    PORT = Number(a);
  }
}
const GET_SSE = process.env.MOCK_GET_SSE === '1';
const CALL_DELAY_MS = Number(process.env.MOCK_CALL_DELAY_MS || 0);

// ---------------------------------------------------------------------------
// 工具目录：严格对齐「bEnableToolSearch=true」时 tools/list 只露 3 个元工具
// ---------------------------------------------------------------------------
const META_TOOLS = [
  {
    name: 'list_toolsets',
    description: 'List the available toolsets and their descriptions.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'describe_toolset',
    description: 'Return the JSON Schemas of the tools in one toolset.',
    inputSchema: {
      type: 'object',
      properties: {
        toolset_name: { type: 'string', description: 'A name from list_toolsets.' },
        tool_name: { type: 'string', description: 'Optional: one tool of that toolset.' },
      },
      required: ['toolset_name'],
    },
  },
  {
    name: 'call_tool',
    description: 'Call one tool by toolset_name and tool_name with arguments matching its schema.',
    inputSchema: {
      type: 'object',
      properties: {
        toolset_name: { type: 'string', description: 'The toolset, from list_toolsets.' },
        tool_name: { type: 'string', description: 'The tool, without the toolset prefix.' },
        arguments: { type: 'object', description: 'Arguments matching the tool input schema.' },
      },
      required: ['tool_name'],
    },
  },
];

/**
 * Toolsets：同时包含 Python 侧全限定名（editor_toolset.*）与 C++ 侧名字
 * （EditorToolset.EditorAppToolset），对应逆向报告 §3.3 的两种命名来源。
 */
const TOOLSETS = {
  'editor_toolset.toolsets.scene.SceneTools': {
    description: 'Level and scene operations (Python toolset).',
    tools: [
      {
        name: 'get_current_level',
        description: 'Returns the currently loaded level.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        // 坑：name / tag / collision_channels 在 schema 里是 required（字面语义），
        // 语义上却是可选的 —— 要表达“任意”必须传 "" / []。
        name: 'find_actors',
        description: 'Finds actors by name, type, tag or bounds.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Exact or partial actor name.' },
            tag: { type: 'string', description: 'Actor tag filter.' },
            collision_channels: {
              type: 'array',
              items: { type: 'string' },
              description: 'Collision channels.',
            },
          },
          required: ['name', 'tag', 'collision_channels'],
        },
      },
      {
        name: 'spawn_actor',
        description: 'Spawns an actor into the current level and returns its refPath.',
        inputSchema: {
          type: 'object',
          properties: {
            actorClass: { type: 'object', description: '{"refPath": "/Script/Engine.PointLight"}' },
            location: { type: 'object' },
          },
          required: ['actorClass', 'location'],
        },
      },
    ],
  },
  'editor_toolset.toolsets.object.ObjectTools': {
    description: 'Generic UObject property access (Python toolset).',
    tools: [
      {
        name: 'get_properties',
        description: 'Reads UObject properties; returns a JSON string in returnValue.',
        inputSchema: {
          type: 'object',
          properties: {
            instance: { type: 'object', description: '{"refPath": "..."}' },
            propertyNames: { type: 'array', items: { type: 'string' } },
          },
          required: ['instance', 'propertyNames'],
        },
      },
      {
        // 坑：values 是 JSON 字符串，不是对象
        name: 'set_properties',
        description: 'Writes UObject properties. `values` is a JSON-encoded string.',
        inputSchema: {
          type: 'object',
          properties: {
            instance: { type: 'object' },
            values: { type: 'string', description: 'JSON string, e.g. "{\\"intensity\\": 10.0}"' },
          },
          required: ['instance', 'values'],
        },
      },
    ],
  },
  'EditorToolset.EditorAppToolset': {
    description: 'Editor application operations (C++ toolset).',
    tools: [
      {
        name: 'CaptureViewport',
        description: 'Captures the active viewport. TOptional params must be passed explicitly as null.',
        inputSchema: {
          type: 'object',
          properties: {
            captureTransform: { type: ['object', 'null'] },
            annotations: { type: ['object', 'null'] },
            bShowUI: { type: 'boolean' },
          },
          required: ['captureTransform', 'annotations', 'bShowUI'],
        },
      },
    ],
  },
};

// TOptional 参数的“必须显式传 null”清单（省略即报 needs a default value）
const OPTIONAL_PARAMS = {
  CaptureViewport: ['captureTransform', 'annotations'],
  // find_actors 的 required 是字面语义，同样必须有 key（缺 key 也报同样错）
  find_actors: ['name', 'tag', 'collision_channels'],
};

const SESSIONS = new Set();
let reqSeq = 0;

// ---------------------------------------------------------------------------
// 服务端观测日志
// ---------------------------------------------------------------------------
function logObservation(entry) {
  const rec = { seq: ++reqSeq, ...entry };
  if (LOG_PATH) {
    try {
      appendFileSync(LOG_PATH, JSON.stringify(rec) + '\n');
    } catch {
      /* 日志写失败不影响协议正确性，测试会因缺记录而失败，属于预期信号 */
    }
  }
  return rec;
}

// ---------------------------------------------------------------------------
// 响应工具函数
// ---------------------------------------------------------------------------
function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

function sendEmpty(res, status, extraHeaders = {}) {
  // 202 必须是真正的空 body
  res.writeHead(status, { 'content-length': '0', ...extraHeaders });
  res.end();
}

/** UE 的 tools/call 回包形态：SSE 帧，且要等 game thread 跑完才发 */
function sendSse(res, body, sid) {
  const frame = `event: message\ndata: ${JSON.stringify(body)}\n\n`;
  const write = () => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'mcp-session-id': sid || '',
      connection: 'keep-alive',
    });
    res.end(frame);
  };
  if (CALL_DELAY_MS > 0) setTimeout(write, CALL_DELAY_MS);
  else write();
}

function textResult(id, text, isError = false) {
  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError } };
}

// ---------------------------------------------------------------------------
// call_tool 派发（复刻 §3.3 语义）
// ---------------------------------------------------------------------------
function handleCallTool(id, params) {
  const name = params?.name;
  const args = params?.arguments || {};

  if (name === 'list_toolsets') {
    const list = Object.entries(TOOLSETS).map(([key, v]) => ({
      name: key,
      description: v.description,
    }));
    return textResult(id, JSON.stringify(list));
  }

  if (name === 'describe_toolset') {
    const ts = TOOLSETS[args.toolset_name];
    if (!ts) {
      return textResult(id, `Unknown toolset "${args.toolset_name}"`, true);
    }
    const tools = args.tool_name ? ts.tools.filter((t) => t.name === args.tool_name) : ts.tools;
    return textResult(id, JSON.stringify(tools));
  }

  if (name === 'call_tool') {
    const toolName = args.tool_name;
    const inner = args.arguments || {};

    // 坑 1：tool_name 必须是短名；带 '.' 的全限定名 → Unknown tool
    if (typeof toolName === 'string' && toolName.includes('.')) {
      return textResult(id, 'Unknown tool', true);
    }

    // 找到一个工具声明（用于确认短名存在）
    const found = Object.entries(TOOLSETS).find(([, v]) =>
      v.tools.some((t) => t.name === toolName),
    );
    if (!found) {
      return textResult(id, `Unknown tool "${toolName}"`, true);
    }

    // 坑 2：TOptional / 字面 required 参数缺失 → needs a default value
    const requiredKeys = OPTIONAL_PARAMS[toolName];
    if (requiredKeys) {
      const missing = requiredKeys.filter((k) => !(k in inner));
      if (missing.length) {
        return textResult(id, `input param "${missing[0]}" needs a default value`, true);
      }
    }

    // 正常返回：文本内容块里是 {"returnValue": ...}
    let returnValue;
    if (toolName === 'get_current_level') {
      returnValue = { levelPath: '/Game/Maps/Main.Main', isPersistent: true };
    } else if (toolName === 'find_actors') {
      returnValue = [
        { refPath: '/Game/Maps/Main.Main:PersistentLevel.PointLight_0', name: 'PointLight_0' },
      ];
    } else if (toolName === 'set_properties') {
      // values 是 JSON 字符串，服务端要 parse 它
      let parsed = null;
      let parseError = null;
      try {
        parsed = JSON.parse(inner.values);
      } catch (e) {
        parseError = String(e.message || e);
      }
      returnValue = parsed && !parseError ? { updated: Object.keys(parsed) } : { error: parseError };
    } else if (toolName === 'CaptureViewport') {
      returnValue = { imagePath: '/tmp/mock-capture.png', bShowUI: inner.bShowUI };
    } else {
      returnValue = { ok: true, tool: toolName, echo: inner };
    }
    return textResult(id, JSON.stringify({ returnValue }));
  }

  return textResult(id, `Unknown tool "${name}"`, true);
}

// ---------------------------------------------------------------------------
// HTTP 服务
// ---------------------------------------------------------------------------
const LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

const server = createServer((req, res) => {
  const base = {
    method: req.method,
    url: req.url,
    accept: req.headers['accept'] || '',
    contentType: req.headers['content-type'] || '',
    sessionHeader: req.headers['mcp-session-id'] || null,
    origin: req.headers.origin || null,
  };

  // 安全：只允许 loopback Origin（UE 同样拒绝非 loopback）
  const origin = req.headers.origin;
  if (origin && !LOOPBACK_ORIGIN.test(origin)) {
    logObservation({ ...base, status: 403, note: 'origin rejected' });
    res.writeHead(403, { 'content-type': 'text/plain' }).end('origin rejected');
    return;
  }

  // GET /mcp：默认 404 —— 模拟不提供 GET SSE 流的引擎 build
  if (req.method === 'GET' && req.url.startsWith('/mcp')) {
    if (!GET_SSE) {
      logObservation({ ...base, status: 404, note: 'no GET SSE stream' });
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    logObservation({ ...base, status: 200, note: 'GET SSE stream opened' });
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(': stream open\n\n');
    req.on('close', () => res.end());
    return;
  }

  if (req.method !== 'POST' || !req.url.startsWith('/mcp')) {
    logObservation({ ...base, status: 404, note: 'not found' });
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    return;
  }

  let body = '';
  req.on('data', (c) => {
    body += c;
    if (body.length > 1_000_000) req.destroy();
  });
  req.on('end', () => {
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      logObservation({ ...base, status: 400, method: 'parse-error' });
      sendJson(res, 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'parse error' },
      });
      return;
    }

    const method = msg.method;
    const id = msg.id;
    const isNotification = id === undefined || id === null;

    // 1) initialize：普通 JSON + mcp-session-id 头（不需要已有 session）
    if (method === 'initialize') {
      const sid = randomUUID();
      SESSIONS.add(sid);
      const requested = msg.params?.protocolVersion;
      const supported = ['2025-06-18', '2025-03-26', '2024-11-05'];
      const protocolVersion = supported.includes(requested) ? requested : '2025-06-18';
      logObservation({
        ...base,
        status: 200,
        method,
        requestedProtocolVersion: requested || null,
        issuedSession: sid,
        note: 'initialize JSON + session header',
      });
      sendJson(
        res,
        200,
        {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: 'unreal-mcp-mock', version: '5.8.0-mock' },
          },
        },
        { 'mcp-session-id': sid },
      );
      return;
    }

    // 2) 除 initialize 外，每个请求都必须回传有效 session 头，否则 400
    const sid = req.headers['mcp-session-id'];
    if (!sid || !SESSIONS.has(sid)) {
      logObservation({ ...base, status: 400, method, note: 'missing/invalid session header' });
      sendJson(res, 400, {
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: 'Bad Request: no valid session ID provided' },
      });
      return;
    }

    // 3) 通知（无 id）→ 202 空体
    if (isNotification) {
      logObservation({ ...base, status: 202, method, note: 'notification accepted' });
      sendEmpty(res, 202, { 'mcp-session-id': sid });
      return;
    }

    // 4) tools/list：普通 JSON，只有三个元工具
    if (method === 'tools/list') {
      logObservation({ ...base, status: 200, method, note: 'tools/list JSON' });
      sendJson(
        res,
        200,
        { jsonrpc: '2.0', id, result: { tools: META_TOOLS } },
        { 'mcp-session-id': sid },
      );
      return;
    }

    // 5) tools/call：SSE
    if (method === 'tools/call') {
      const result = handleCallTool(id, msg.params);
      logObservation({
        ...base,
        status: 200,
        method,
        note: 'tools/call SSE',
        responseContentType: 'text/event-stream',
        tool: msg.params?.name || null,
      });
      sendSse(res, result, sid);
      return;
    }

    // 6) ping → 空结果（SDK 可能用）
    if (method === 'ping') {
      logObservation({ ...base, status: 200, method });
      sendJson(res, 200, { jsonrpc: '2.0', id, result: {} }, { 'mcp-session-id': sid });
      return;
    }

    // 注意：走到这里说明 session 是有效的。像 server/discover 这种「无 session」的探测
    // 会先被上面的 session 检查拦成 400（与真 UE 一致），不会到这里。
    logObservation({ ...base, status: 404, method, note: 'method not found' });
    sendJson(
      res,
      404,
      { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } },
      { 'mcp-session-id': sid },
    );
  });
});

server.listen(PORT, '127.0.0.1', () => {
  const actual = server.address().port;
  // 稳定机器可读的就绪行（测试从这里拿 URL，同时验证「端口可传参」）
  console.log(`MOCK_READY http://127.0.0.1:${actual}/mcp`);
  console.log(`[mock-unreal-mcp] listening on http://127.0.0.1:${actual}/mcp`);
  if (LOG_PATH) console.log(`[mock-unreal-mcp] observation log: ${LOG_PATH}`);
  console.log(
    `[mock-unreal-mcp] GET_SSE=${GET_SSE ? 'enabled' : 'disabled (404)'} CALL_DELAY_MS=${CALL_DELAY_MS}`,
  );
});

server.on('error', (err) => {
  console.error(`[mock-unreal-mcp] listen error: ${err.message}`);
  process.exit(2);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 300).unref();
  });
}
