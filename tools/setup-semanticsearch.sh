#!/usr/bin/env bash
# setup-semanticsearch.sh —— 让 UE 5.8 的 SemanticSearch 工具在不花钱的情况下可用
#
# 做三件事：
#   1. 装 llama.cpp（提供本地 embedding 服务，OpenAI 兼容）
#   2. 从 HuggingFace 拉 Qwen3-Embedding-0.6B 的 GGUF（~640 MB）
#   3. 启动 llama-server（embedding）+ 本仓库的 shim（把 json_schema 翻译成
#      json_object，并把请求转发给真正的 caption 模型）
#
# 用法：
#   export SHIM_UPSTREAM_BASE=https://api.deepseek.com
#   export SHIM_UPSTREAM_KEY=sk-xxxx        # 任何支持「看图 + json_object」的模型
#   ./tools/setup-semanticsearch.sh
#
# 之后在 UE 里填（Project Settings -> Plugins -> Semantic Search）：
#   CaptioningBaseUrl   = http://127.0.0.1:8765/v1
#   CaptioningApiKey    = local
#   CaptioningModel     = deepseek-flash
#   EmbeddingBaseUrl    = http://127.0.0.1:8765/v1
#   EmbeddingApiKey     = local
#   EmbeddingModel      = qwen3-embedding
#   EmbeddingDimension  = 1024
#
# ⚠️ EmbeddingDimension 必须等于本地 embedding 服务真实返回的向量长度，
#    否则 UE 会在 FlatVectorIndex.cpp 断言 `QueryVector.Num() == Dimension` 直接崩编辑器。

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODEL_DIR="${SEM_MODEL_DIR:-$HOME/.cache/ue-semanticsearch}"
GGUF_NAME="Qwen3-Embedding-0.6B-Q8_0.gguf"
GGUF_URL="https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/main/${GGUF_NAME}"
EMBED_PORT="${SEM_EMBED_PORT:-8766}"
SHIM_PORT="${SEM_SHIM_PORT:-8765}"
# llama.cpp 的 Qwen3-Embedding 输出 1024 维；换模型必须同步改这里和 UE 的设置。
EMBED_DIM="${SEM_EMBED_DIM:-1024}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
die()  { printf '\033[31m❌ %s\033[0m\n' "$*" >&2; exit 1; }

command -v brew >/dev/null 2>&1 || die "需要 Homebrew（https://brew.sh）"

if ! command -v llama-server >/dev/null 2>&1; then
  bold "1/4 安装 llama.cpp"
  HOMEBREW_NO_AUTO_UPDATE=1 brew install llama.cpp
else
  bold "1/4 llama-server 已安装：$(command -v llama-server)"
fi

mkdir -p "$MODEL_DIR"
if [ ! -f "$MODEL_DIR/$GGUF_NAME" ]; then
  bold "2/4 下载 embedding 模型（~640 MB）"
  curl -fL --progress-bar -o "$MODEL_DIR/$GGUF_NAME" "$GGUF_URL"
else
  bold "2/4 模型已存在：$MODEL_DIR/$GGUF_NAME"
fi

if lsof -nP -iTCP:"$EMBED_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  bold "3/4 embedding 服务已在 $EMBED_PORT 运行"
else
  bold "3/4 启动 embedding 服务（127.0.0.1:$EMBED_PORT）"
  nohup llama-server -m "$MODEL_DIR/$GGUF_NAME" --embedding \
    --host 127.0.0.1 --port "$EMBED_PORT" -np 1 \
    > "$MODEL_DIR/llama-embed.log" 2>&1 &
  for _ in $(seq 1 60); do
    curl -s -m 2 "http://127.0.0.1:$EMBED_PORT/health" >/dev/null 2>&1 && break
    sleep 1
  done
  curl -s -m 2 "http://127.0.0.1:$EMBED_PORT/health" >/dev/null 2>&1 \
    || die "embedding 服务没起来，看 $MODEL_DIR/llama-embed.log"
  info "embedding 服务就绪，维度应为 $EMBED_DIM"
fi

if lsof -nP -iTCP:"$SHIM_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  bold "4/4 shim 已在 $SHIM_PORT 运行"
else
  bold "4/4 启动 shim（127.0.0.1:$SHIM_PORT）"
  : "${SHIM_UPSTREAM_BASE:=https://api.deepseek.com}"
  : "${SHIM_UPSTREAM_KEY:?请先 export SHIM_UPSTREAM_KEY=<你的 key>}"
  export SHIM_UPSTREAM_BASE SHIM_UPSTREAM_KEY
  export SHIM_EMBED_URL="http://127.0.0.1:$EMBED_PORT/v1/embeddings"
  export SHIM_PORT="$SHIM_PORT"
  nohup python3 "$HERE/semanticsearch-shim.py" > "$MODEL_DIR/shim.log" 2>&1 &
  sleep 2
  curl -s -m 3 "http://127.0.0.1:$SHIM_PORT/v1/models" >/dev/null 2>&1 \
    || die "shim 没起来，看 $MODEL_DIR/shim.log"
  info "shim 就绪"
fi

cat <<TXT

✅ 全部就绪。现在在 UE 里填（Project Settings → Plugins → Semantic Search）：

  CaptioningBaseUrl    = http://127.0.0.1:$SHIM_PORT/v1
  CaptioningApiKey     = local
  CaptioningModel      = deepseek-flash
  EmbeddingBaseUrl     = http://127.0.0.1:$SHIM_PORT/v1
  EmbeddingApiKey      = local
  EmbeddingModel       = qwen3-embedding
  EmbeddingDimension   = $EMBED_DIM

或者用 MCP 直接写（不落盘、只改内存，重启失效）：

  ConfigSettingsToolset.SetSectionProperties({
    containerName: 'Editor', categoryName: 'Plugins', sectionName: 'Semantic Search',
    propertiesJson: JSON.stringify({
      CaptioningBaseUrl: 'http://127.0.0.1:$SHIM_PORT/v1', CaptioningApiKey: 'local',
      CaptioningModel: 'deepseek-flash',
      EmbeddingBaseUrl: 'http://127.0.0.1:$SHIM_PORT/v1', EmbeddingApiKey: 'local',
      EmbeddingModel: 'qwen3-embedding', EmbeddingDimension: $EMBED_DIM,
    }),
  })

⚠️ 改 EmbeddingDimension 必须在**编辑器启动前**改好。运行中改维度会让 UE 用旧维度的
   索引去查新维度的向量，触发 FlatVectorIndex.cpp 的
   `check(QueryVector.Num() == Dimension)` 断言 → 直接崩编辑器。
   已经改过的话：删掉 <Project>/Saved/SemanticSearch/SearchIndex.bin 再重启编辑器。

TXT
