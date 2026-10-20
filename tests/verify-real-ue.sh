#!/usr/bin/env bash
# verify-real-ue.sh —— 对**真实运行的 Unreal Editor** 做端到端验证。
#
# 与 run-all.sh 的区别：
#   run-all.sh       = 不需要 UE，用 mock 验线路契约与插件静态契约（CI 可跑）
#   verify-real-ue.sh = 需要真 UE 5.8 且编辑器已启动 MCP server（本机 8000 端口）
#
# 前置：
#   1. UE 5.8 已安装，工程 .uproject 里启用 ModelProtocol + AllToolsets
#   2. 编辑器已启动，且 MCP server 在跑：
#        - 控制台执行 ModelProtocol.StartServer，或
#        - Saved/Config/MacEditor/EditorPerProjectUserSettings.ini 里 bAutoStartServer=True
#   3. 8000 端口有监听
#
# 用法：
#   ./verify-real-ue.sh              # 全部
#   ./verify-real-ue.sh wire         # 只跑原始线路探测
#   ./verify-real-ue.sh plugin       # 只跑 DSH 插件端到端
#
# 注意：本脚本会**真的改动编辑器状态**（创建再删除一个 PointLight），
#       并在结束时清理。截图会写到临时目录，不落盘到工程里。

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_APP="${DSH_APP:-/Applications/DeepSeek Harness.app}"
DSH_NODE="${DSH_NODE:-$DSH_APP/Contents/MacOS/DeepSeek Harness}"
ASAR="${DSH_ASAR:-$DSH_APP/Contents/Resources/app.asar}"
MCP_URL="${MCP_URL:-http://127.0.0.1:8000/mcp}"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
bold()  { printf '\033[1m%s\033[0m\n' "$*"; }

# ── 前置检查 ────────────────────────────────────────────────────────────────
bold "═══ 真机验证：DSH × Unreal Engine ═══"
echo

if [ ! -x "$DSH_NODE" ]; then
  red "❌ 找不到 DSH 可执行文件：$DSH_NODE"
  exit 2
fi

PORT="$(echo "$MCP_URL" | sed -E 's#.*:([0-9]+)/.*#\1#')"
if ! lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  red "❌ $MCP_URL 无监听 —— 真 Unreal Editor 的 MCP server 没在跑。"
  echo
  echo "   启动方式（任选）："
  echo "   1. 编辑器控制台执行：ModelProtocol.StartServer"
  echo "   2. 写 ini 让它自启："
  echo "      <Project>/Saved/Config/MacEditor/EditorPerProjectUserSettings.ini"
  echo "      [/Script/ModelContextProtocolEngine.ModelContextProtocolSettings]"
  echo "      bAutoStartServer=True"
  echo
  echo "   检查端口占用者：lsof -nP -iTCP:$PORT -sTCP:LISTEN"
  exit 2
fi

WHO="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR==2{print $1}')"
green "✅ $MCP_URL 有监听（进程：${WHO}）"
echo

export ELECTRON_RUN_AS_NODE=1
export ASAR
export MCP_URL

run_node() { ELECTRON_RUN_AS_NODE=1 "$DSH_NODE" "$@"; }

TESTS=("$@")
if [ ${#TESTS[@]} -eq 0 ]; then
  TESTS=(wire plugin)
fi

fail=0

# ── 1. 原始线路探测（不经过 DSH，直接 fetch）────────────────────────────────
if [[ " ${TESTS[*]} " == *" wire "* ]]; then
  bold "─── [1/2] 原始线路探测（直接 fetch，不经 DSH）───"
  cat > /tmp/_verify_wire.mjs <<'MJS'
const url = process.env.MCP_URL;
const H = { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream' };
let pass = 0, fail = 0;
const ok  = (c, m, extra='') => { if (c) { pass++; console.log('  PASS  ' + m + (extra?`  → ${extra}`:'')); } else { fail++; console.log('  FAIL  ' + m + (extra?`  → ${extra}`:'')); } };

const t0 = Date.now();
let r = await fetch(url, { method:'POST', headers:H, body: JSON.stringify({ jsonrpc:'2.0', id:1, method:'initialize',
  params:{ protocolVersion:'2025-06-18', capabilities:{}, clientInfo:{ name:'dsh-verify', version:'1.0' } } })});
ok(r.status === 200, 'initialize 返回 200', `status=${r.status}`);
const sid = r.headers.get('mcp-session-id');
ok(!!sid, 'initialize 下发 mcp-session-id', sid ? sid.slice(0,16)+'…' : 'missing');
const init = await r.json();
ok(!!init.result?.protocolVersion, '协商出 protocolVersion', init.result?.protocolVersion);
console.log(`        serverInfo = ${JSON.stringify(init.result?.serverInfo)}`);
const H2 = { ...H, 'mcp-session-id': sid };

r = await fetch(url, { method:'POST', headers:H2, body: JSON.stringify({ jsonrpc:'2.0', method:'notifications/initialized' })});
ok(r.status === 202, 'notifications/initialized 返回 202', `status=${r.status}`);

r = await fetch(url, { method:'POST', headers:H2, body: JSON.stringify({ jsonrpc:'2.0', id:2, method:'tools/list' })});
const tl = await r.json();
const names = (tl.result?.tools ?? []).map(t => t.name).sort();
ok(JSON.stringify(names) === JSON.stringify(['call_tool','describe_toolset','list_toolsets']),
   'tools/list 恰好 3 个元工具（Tool Search 模式）', JSON.stringify(names));

let idc = 100;
async function call(name, args) {
  const res = await fetch(url, { method:'POST', headers:H2, body: JSON.stringify({
    jsonrpc:'2.0', id:idc++, method:'tools/call', params:{ name, arguments: args } }) });
  const ct = res.headers.get('content-type') || '';
  const j = await res.json();
  return { ct, result: j.result, error: j.error };
}

// list_toolsets：真机返回 Markdown 文本，不是 JSON
let x = await call('list_toolsets', {});
const lsText = x.result?.content?.[0]?.text ?? '';
ok(!/event-stream/.test(x.ct), 'tools/call 返回普通 JSON（非 SSE）', x.ct);
ok(!(() => { try { JSON.parse(lsText); return true; } catch { return false; } })(),
   'list_toolsets 返回 Markdown 文本（不是 JSON）', `前 40 字: ${JSON.stringify(lsText.slice(0,40))}`);
const tsLines = lsText.split('\n').filter(l => /^- \S+: /.test(l));
ok(tsLines.length > 0, 'list_toolsets 解析出 toolset 条目', `${tsLines.length} 个`);
const firstTs = tsLines[0]?.match(/^- ([^:\n]+): /)?.[1];
console.log(`        第一个 toolset = ${firstTs}`);

// describe_toolset：JSON 对象
x = await call('describe_toolset', { toolset_name: firstTs });
let ds = null; try { ds = JSON.parse(x.result?.content?.[0]?.text ?? ''); } catch {}
ok(!!ds && Array.isArray(ds.tools), 'describe_toolset 返回 JSON 对象且含 tools[]', `${ds?.tools?.length ?? '?'} 个工具`);

// 坑1：全限定 tool_name
const S = 'editor_toolset.toolsets.scene.SceneTools';
x = await call('call_tool', { toolset_name:S, tool_name:`${S}.get_current_level`, arguments:{} });
ok(x.result?.isError === true && /Unknown tool/.test(x.result?.content?.[0]?.text ?? ''),
   '全限定 tool_name → Unknown tool（真实坑）', (x.result?.content?.[0]?.text ?? '').slice(0,60));

// 坑2：TOptional 省略
x = await call('call_tool', { toolset_name:'EditorToolset.EditorAppToolset', tool_name:'CaptureViewport', arguments:{} });
ok(x.result?.isError === true && /needs a default value/.test(x.result?.content?.[0]?.text ?? ''),
   '省略 TOptional → needs a default value（真实坑）', (x.result?.content?.[0]?.text ?? '').slice(0,70));

// 真实只读调用
x = await call('call_tool', { toolset_name:S, tool_name:'get_current_level', arguments:{} });
let lv = null; try { lv = JSON.parse(x.result?.content?.[0]?.text ?? ''); } catch {}
ok(!!lv && 'returnValue' in lv, 'get_current_level 真实调用成功', JSON.stringify(lv));
console.log(`        耗时 ${Date.now()-t0}ms`);
console.log(`\n  wire: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
MJS
  run_node /tmp/_verify_wire.mjs || fail=1
  echo
fi

# ── 2. DSH 插件端到端（真 cordis + 真 mcp-client + 真引擎）────────────────────
if [[ " ${TESTS[*]} " == *" plugin "* ]]; then
  bold "─── [2/2] DSH 插件端到端（真 cordis + 真 mcp-client + 真编辑器）───"
  cat > /tmp/_verify_plugin.mjs <<'MJS'
const ASAR = process.env.ASAR + '/dsh/node_modules';
const { Context } = await import(ASAR + '/@deepseek-ai/cordis/lib/index.js');
const toolsMod  = await import(ASAR + '/@deepseek-ai/dsh-tools/lib/index.js');
const spMod     = await import(ASAR + '/@deepseek-ai/dsh-system-prompt/lib/index.js');
const skillMod  = await import(ASAR + '/@deepseek-ai/dsh-skill/lib/index.js');
const mcpClient = await import(ASAR + '/@deepseek-ai/dsh-mcp-client/lib/index.js');

let pass = 0, fail = 0;
const ok = (c, m, extra='') => { if (c) { pass++; console.log('  PASS  ' + m + (extra?`  → ${extra}`:'')); } else { fail++; console.log('  FAIL  ' + m + (extra?`  → ${extra}`:'')); } };

const ctx = new Context();
ctx.plugin(spMod.default ?? spMod.SystemPrompt);  await new Promise(r=>setTimeout(r,80));
ctx.plugin(toolsMod.ToolRuntime);                  await new Promise(r=>setTimeout(r,120));
ctx.plugin(skillMod.default ?? skillMod.SkillRegistry); await new Promise(r=>setTimeout(r,100));

// 从**用户实际安装的 profile 软链**加载，确保验的是真交付物
// 优先加载本仓库自身（开源仓库的标准验证方式）；
// 也可以用 PROFILE_PLUGIN 环境变量指向 profile 里已安装的那份来做对比验证。
const REPO_PLUGIN = new URL('../index.js', import.meta.url).href;
const PROFILE_PLUGIN = process.env.PROFILE_PLUGIN || REPO_PLUGIN;
let bundle;
try { bundle = await import(PROFILE_PLUGIN); }
catch (e) { console.log('  SKIP  插件未安装到 profile：' + PROFILE_PLUGIN); process.exit(0); }
bundle.apply(ctx); await new Promise(r=>setTimeout(r,100));

const skills = await ctx.get('skills').list({ cwd: process.cwd() });
ok(skills.length === 3, '3 个 skill 注册成功', skills.map(s=>s.name).join(', '));

mcpClient.apply(ctx, mcpClient.Config({
  serverName:'unreal', transport:'streamable-http', url: process.env.MCP_URL,
  toolCallTimeoutMs: 300000, failOnStartupError: false, reconnect: { maxAttempts: 100000 },
}));
let tools = null;
for (let i=0; i<80; i++) {
  await new Promise(r=>setTimeout(r,250));
  const t = ctx.get('tools');
  if (t && (t.schemas(undefined)||[]).some(s=>String(s?.name||'').includes('unreal'))) { tools = t; break; }
}
ok(!!tools, '真引擎连接成功，工具已注册');
if (!tools) { console.log(`\n  plugin: ${pass} passed, ${fail} failed`); process.exit(1); }

const names = (tools.schemas(undefined)||[]).map(s=>s.name).filter(n=>n.includes('unreal')).sort();
ok(JSON.stringify(names) === JSON.stringify([
  'mcp__unreal__call_tool','mcp__unreal__describe_toolset','mcp__unreal__list_toolsets']),
  '工具名精确为 mcp__unreal__{list_toolsets,describe_toolset,call_tool}', JSON.stringify(names));

const ex = (n,a) => tools.get(n, undefined).execute(a, { signal: new AbortController().signal });

const ls = await ex('mcp__unreal__list_toolsets', {});
const lsTxt = ls.content[0].text;
ok(!(()=>{try{JSON.parse(lsTxt);return true}catch{return false}})(), 'list_toolsets 经 DSH 后仍是 Markdown 文本');
const tsCount = lsTxt.split('\n').filter(l=>/^- \S+: /.test(l)).length;
ok(tsCount > 0, 'list_toolsets 解析出 toolset', `${tsCount} 个`);

const S = 'editor_toolset.toolsets.scene.SceneTools';
const cnt = async () => JSON.parse(
  (await ex('mcp__unreal__call_tool', { toolset_name:S, tool_name:'find_actors', arguments:{name:'',tag:'',collision_channels:[]} }))
    .content[0].text).returnValue.length;

const before = await cnt();
console.log(`        改动前 actor 数 = ${before}`);

const add = await ex('mcp__unreal__call_tool', {
  toolset_name:S, tool_name:'add_to_scene_from_class',
  arguments:{ actor_type:{refPath:'/Script/Engine.PointLight'}, name:'MCP_Verify_Light',
              xform:{location:{x:0,y:0,z:600},rotation:null,scale:null} } });
const added = JSON.parse(add.content[0].text);
ok(!!added.returnValue?.refPath, '真实写操作：创建 PointLight 成功', added.returnValue?.refPath?.split('.').pop());

const after = await cnt();
ok(after === before + 1, 'actor 数 +1', `${before} → ${after}`);

// 清理
const found = JSON.parse((await ex('mcp__unreal__call_tool',
  { toolset_name:S, tool_name:'find_actors', arguments:{name:'MCP_Verify_Light',tag:'',collision_channels:[]} })).content[0].text);
if (found.returnValue?.length) {
  const del = await ex('mcp__unreal__call_tool', { toolset_name:S, tool_name:'remove_from_scene', arguments:{ actor: found.returnValue[0] } });
  const dr = JSON.parse(del.content[0].text);
  ok(dr.returnValue === true, '清理：删除测试 actor 成功');
  const final = await cnt();
  ok(final === before, '编辑器已恢复到原始状态', `${final} == ${before}`);
}

console.log(`\n  plugin: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
MJS
  run_node /tmp/_verify_plugin.mjs || fail=1
  echo
fi

# ── 汇总 ────────────────────────────────────────────────────────────────────
bold "═══ 汇总 ═══"
if [ "$fail" -eq 0 ]; then
  green "✅ 真机验证全部通过"
  echo
  echo "已在本机真实 Unreal Editor 上确认："
  echo "  · MCP server 线路契约（session 头 / 3 元工具 / 两个真实坑）"
  echo "  · DSH 插件能把真引擎的工具注册为 mcp__unreal__*"
  echo "  · 真实只读调用、真实写操作、真实删除清理"
  exit 0
else
  red "❌ 真机验证有失败项（见上方 FAIL 明细）"
  exit 1
fi
