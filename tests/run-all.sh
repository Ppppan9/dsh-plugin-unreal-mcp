#!/usr/bin/env bash
# run-all.sh —— DSH × Unreal Engine MCP 验证工程一键运行入口
#
# 用法：
#   ./run-all.sh                 # 跑全部
#   ./run-all.sh wire            # 只跑 wire-contract
#   ./run-all.sh unit integ      # 跑指定几项
#
# 设计要点：
#   - 必须用 DSH 自带的 Electron 二进制当 Node 跑（ELECTRON_RUN_AS_NODE=1），
#     因为测试要 import asar 内的真 MCP SDK / cordis / dsh-* 包。
#   - 不要真 Unreal Engine：全部基于 tests/mock-unreal-mcp.mjs。
#   - 任何一项失败 → 脚本非零退出。
#   - 端口全部由 mock 自选（临时端口），不写死、不需要 8000 空闲。

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------------------
# 定位运行环境
# ---------------------------------------------------------------------------
DSH_APP="${DSH_APP:-/Applications/DeepSeek Harness.app}"
DSH_NODE="${DSH_NODE:-$DSH_APP/Contents/MacOS/DeepSeek Harness}"
DSH_ASAR="${DSH_ASAR:-$DSH_APP/Contents/Resources/app.asar}"

if [ ! -x "$DSH_NODE" ]; then
  echo "❌ 找不到 DSH 可执行文件：$DSH_NODE"
  echo "   可用 DSH_NODE=... 覆盖，例如："
  echo "   DSH_NODE='/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' ./run-all.sh"
  exit 2
fi

if [ ! -f "$DSH_ASAR" ]; then
  echo "❌ 找不到 DSH app.asar：$DSH_ASAR"
  exit 2
fi

# 统一导出，测试文件与它们拉起的 mock 子进程都继承
export ELECTRON_RUN_AS_NODE=1
export DSH_ASAR
export DSH_NODE

# 用 DSH 的 Electron 当 Node 执行任意 .mjs
run_node() {
  ELECTRON_RUN_AS_NODE=1 "$DSH_NODE" "$@"
}

# ---------------------------------------------------------------------------
# 前置检查：plugin/ 是否就绪
#   unit / integration 都依赖 plugin/；plugin/ 缺失时它们应标记为 SKIPPED 而不是 FAIL，
#   但退出码仍要能和「测试真的失败」区分开：
#      0 = 全过
#      1 = 有测试 FAIL
#      2 = 运行环境问题（找不到 DSH）
#      3 = plugin/ 未就绪导致 unit/integration 被跳过（wire-contract 仍然有意义）
# ---------------------------------------------------------------------------
PLUGIN_DIR="$HERE/.."
plugin_file_count=0
if [ -d "$PLUGIN_DIR" ]; then
  plugin_file_count=$(find "$PLUGIN_DIR" -type f 2>/dev/null | wc -l | tr -d ' ')
fi
# 判断 plugin/ 是否「足以跑完整测试」：
#   三个关键文件 + 三个 SKILL.md + locale 两份。
# 注意：integration 只依赖 cordis.patch.yml，plugin-unit 还依赖 skills/ 文本，
# 所以这里用「全量就绪」判据；partial 状态会在汇总里明确说明。
plugin_ready=0
plugin_missing=()
[ -f "$PLUGIN_DIR/index.js" ]        || plugin_missing+=("index.js")
[ -f "$PLUGIN_DIR/package.json" ]    || plugin_missing+=("package.json")
[ -f "$PLUGIN_DIR/cordis.patch.yml" ]|| plugin_missing+=("cordis.patch.yml")
for s in unreal-mcp create-toolset unreal-skill; do
  [ -f "$PLUGIN_DIR/skills/$s/SKILL.md" ] || plugin_missing+=("skills/$s/SKILL.md")
done
[ -f "$PLUGIN_DIR/locale/en.json" ]  || plugin_missing+=("locale/en.json")
[ -f "$PLUGIN_DIR/locale/zh.json" ]  || plugin_missing+=("locale/zh.json")
if [ ${#plugin_missing[@]} -eq 0 ]; then
  plugin_ready=1
fi

# ---------------------------------------------------------------------------
# 选择要跑的项
# ---------------------------------------------------------------------------
TESTS=("$@")
if [ ${#TESTS[@]} -eq 0 ]; then
  TESTS=(wire unit integration)
fi

# 显式请求了 unit/integration 但 plugin/ 没就绪时，提前把话说清楚
if [ "$plugin_ready" -eq 0 ]; then
  echo "⚠️  plugin/ 尚未完整就绪（$PLUGIN_DIR 下 $plugin_file_count 个文件）"
  if [ ${#plugin_missing[@]} -gt 0 ]; then
    echo "    缺少："
    for m in "${plugin_missing[@]}"; do echo "      - $m"; done
  fi
  echo "    汇总里会区分：unit/integration 若失败会标 SKIPPED（未验证），而非 FAIL。"
  echo "    wire-contract 不依赖 plugin/，照常运行。"
  echo
fi

declare -a NAMES=()
declare -a RESULTS=()
declare -a DURATIONS=()

fail_count=0
skipped_count=0
total_pass_asserts=0
total_fail_asserts=0

# 从测试输出里抽取 "N passed, M failed" 汇总行 → echo "N M"
extract_counts() {
  local line p f
  line="$(grep -Eo '[0-9]+ passed, [0-9]+ failed' "$1" 2>/dev/null | tail -1)"
  if [ -z "$line" ]; then
    echo "0 0"
    return
  fi
  p="$(echo "$line" | sed -E 's/^([0-9]+) passed.*/\1/')"
  f="$(echo "$line" | sed -E 's/.*, ([0-9]+) failed$/\1/')"
  echo "$p $f"
}

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  DSH × Unreal Engine MCP — 验证工程（无真 UE，基于线路 mock）║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo "工作目录 : $HERE"
echo "运行时   : $DSH_NODE"
echo "asar     : $DSH_ASAR"
run_node --version | sed 's/^/Node 版本: /'
echo

start_all=$(date +%s)

for t in "${TESTS[@]}"; do
  case "$t" in
    wire|wire-contract)     file="wire-contract.test.mjs";  label="wire-contract" ;;
    unit|plugin-unit)       file="plugin-unit.test.mjs";    label="plugin-unit" ;;
    integration|integ)      file="integration.test.mjs";    label="integration" ;;
    *) echo "❌ 未知测试名: $t（可选：wire / unit / integration）"; exit 2 ;;
  esac

  echo "──────────────────────────────────────────────────────────────"
  echo "▶ 运行 $label  ($file)"
  echo "──────────────────────────────────────────────────────────────"

  out_file="$(mktemp -t "dsvue-$label.XXXXXX")"
  t0=$(date +%s)

  # 同时打到屏幕和文件：屏幕给人看，文件用于抽取断言统计
  rc=0
  run_node "$HERE/$file" 2>&1 | tee "$out_file" || rc=$?

  t1=$(date +%s)
  dur=$((t1 - t0))

  counts="$(extract_counts "$out_file")"
  p="$(echo "$counts" | awk '{print $1}')"
  f="$(echo "$counts" | awk '{print $2}')"
  : "${p:=0}"; : "${f:=0}"
  total_pass_asserts=$((total_pass_asserts + p))
  total_fail_asserts=$((total_fail_asserts + f))

  NAMES+=("$label")
  DURATIONS+=("${dur}s")

  # plugin/ 未就绪时，unit / integration 的失败是「未验证」而不是「验证不通过」
  case "$label" in
    plugin-unit|integration) needs_plugin=1 ;;
    *) needs_plugin=0 ;;
  esac

  if [ $rc -eq 0 ]; then
    RESULTS+=("PASS")
    echo "✅ $label: PASS（${p} 断言通过，${dur}s）"
  elif [ "$needs_plugin" -eq 1 ] && [ "$plugin_ready" -eq 0 ]; then
    RESULTS+=("SKIPPED")
    skipped_count=$((skipped_count + 1))
    total_pass_asserts=$((total_pass_asserts - p))
    total_fail_asserts=$((total_fail_asserts - f))
    echo "⚠️  $label: SKIPPED（plugin/ 未就绪，本项为「未验证」而非「验证不通过」）"
  else
    RESULTS+=("FAIL")
    fail_count=$((fail_count + 1))
    echo "❌ $label: FAIL（rc=$rc，${p} 通过 / ${f} 失败，${dur}s）"
  fi

  rm -f "$out_file"
  echo
done

end_all=$(date +%s)
total_dur=$((end_all - start_all))

# ---------------------------------------------------------------------------
# 汇总表
# ---------------------------------------------------------------------------
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║                          汇总                                ║"
echo "╚══════════════════════════════════════════════════════════════╝"
printf '%-16s %-8s %s\n' "测试" "结果" "耗时"
printf '%-16s %-8s %s\n' "────────────────" "────────" "────────"
for i in "${!NAMES[@]}"; do
  printf '%-16s %-8s %s\n' "${NAMES[$i]}" "${RESULTS[$i]}" "${DURATIONS[$i]}"
done
echo "────────────────────────────────────────────────────────────"
echo "断言总计   : $total_pass_asserts passed, $total_fail_asserts failed"
echo "测试文件   : $(( ${#NAMES[@]} - fail_count - skipped_count ))/${#NAMES[@]} 通过，$skipped_count 跳过"
echo "总耗时     : ${total_dur}s"
echo

if [ "$fail_count" -ne 0 ]; then
  echo "❌ 有 $fail_count 个测试文件失败（见上方失败明细）"
  exit 1
fi

if [ "$skipped_count" -ne 0 ]; then
  echo "⚠️  有 $skipped_count 个测试文件因 plugin/ 未就绪被跳过 —— 这些项属于「未验证」，不是「通过」。"
  echo "    plugin/ 落地后请重新运行 ./run-all.sh 以获得完整结论。"
  exit 3
fi

echo "✅ 全部通过"
echo
echo "边界声明：本套自动化测试不接触真 Unreal Engine —— 全部断言基于"
echo "          tests/mock-unreal-mcp.mjs 复刻的线路契约与 plugin/ 的静态契约。"
if lsof -nP -iTCP:8000 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "          检测到 127.0.0.1:8000 有监听（可能是在跑的真 Unreal Editor）。"
  echo "          真机验证请另跑：./verify-real-ue.sh（需要编辑器已启动 MCP server）"
else
  echo "          当前未检测到真 Unreal Editor 的 MCP server（8000 端口无监听）。"
  echo "          真机验证请先启动编辑器，再跑：./verify-real-ue.sh"
fi
exit 0
