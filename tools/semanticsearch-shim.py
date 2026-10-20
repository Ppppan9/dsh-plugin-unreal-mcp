#!/usr/bin/env python3
"""
OpenAI-compatible shim for UE 5.8 SemanticSearch.

WHY THIS EXISTS
---------------
UE 5.8's SemanticSearch plugin (Engine/Plugins/Experimental/SemanticSearch)
speaks the OpenAI protocol, but with two requirements that most non-OpenAI
backends do not meet:

  1. caption  -> POST {base}/chat/completions with
     response_format: {"type":"json_schema","json_schema":{...,"strict":true}}
     DeepSeek (and several other providers) reject "json_schema" with
     HTTP 400 "This response_format type is unavailable now", while accepting
     {"type":"json_object"}.

  2. embedding -> POST {base}/embeddings
     DeepSeek has NO embeddings endpoint at all (verified: /embeddings,
     /v1/embeddings, /embed all return HTTP 404), so a second, separate
     service is required.

This shim sits in front of BOTH and makes them look like one OpenAI endpoint:

  * /v1/embeddings      -> proxies to a local embedding server
                           (llama.cpp `llama-server --embedding`), because that
                           server returns the real vector length, which is what
                           UE uses to size its index. UE's `dimensions` request
                           field is ignored by llama.cpp, so
                           `EmbeddingDimension` MUST equal the server's real
                           output length (e.g. 1024 for Qwen3-Embedding-0.6B).

  * /v1/chat/completions -> rewrites json_schema -> json_object, injects the
                           schema into the system prompt, then re-validates and
                           repairs the model's JSON so UE's strict parser
                           (which requires {tags:[string], caption:string} and
                           finish_reason == "stop") accepts it.

NO CREDENTIAL IS EVER STORED IN THIS FILE. The caption upstream key is read
from the environment; the embedding server is local and unauthenticated.

Usage
-----
  export SHIM_UPSTREAM_BASE=https://api.deepseek.com
  export SHIM_UPSTREAM_KEY=sk-...
  export SHIM_EMBED_URL=http://127.0.0.1:8766/v1/embeddings
  python3 tools/semanticsearch-shim.py

Then in Unreal: Project Settings -> Plugins -> Semantic Search
  CaptioningBaseUrl = http://127.0.0.1:8765/v1
  CaptioningApiKey  = local          (any non-empty string; it is not validated)
  CaptioningModel   = deepseek-flash (must support images + json_object)
  EmbeddingBaseUrl  = http://127.0.0.1:8765/v1
  EmbeddingApiKey   = local
  EmbeddingModel    = qwen3-embedding
  EmbeddingDimension = 1024          (MUST equal the local server's real length)

See skills/unreal-mcp/references/operations.md for the full setup recipe.
"""
import json, os, sys, urllib.request, urllib.error, re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM_BASE = os.environ.get("SHIM_UPSTREAM_BASE", "https://api.deepseek.com")
EMBED_URL    = os.environ.get("SHIM_EMBED_URL", "http://127.0.0.1:8766/v1/embeddings")
UPSTREAM_KEY = os.environ.get("SHIM_UPSTREAM_KEY", "")
EMBED_MODEL  = os.environ.get("SHIM_EMBED_MODEL", "")
PORT         = int(os.environ.get("SHIM_PORT", "8765"))
LOG = open(os.environ.get("SHIM_LOG", "/tmp/uefull/shim.log"), "a", buffering=1)


def log(*a):
    print(*a, file=LOG, flush=True)


def local_post(url, body):
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read().decode())


def upstream(path, body, extra_headers=None):
    req = urllib.request.Request(
        UPSTREAM_BASE + path,
        data=json.dumps(body).encode(),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {UPSTREAM_KEY}",
            **(extra_headers or {}),
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read().decode())


def coerce_to_schema(obj, schema):
    """Best-effort repair so UE's strict parser gets {tags:[string], caption:string}."""
    if not isinstance(obj, dict):
        obj = {}
    out = {}
    props = schema.get("properties", {})
    for key, spec in props.items():
        if key not in obj:
            continue
        val = obj[key]
        t = spec.get("type")
        if t == "array":
            if not isinstance(val, list):
                val = [] if val in (None, "") else [val]
            item_t = (spec.get("items") or {}).get("type", "string")
            if item_t == "string":
                val = [str(x) for x in val]
        elif t == "string":
            if not isinstance(val, str):
                val = json.dumps(val, ensure_ascii=False) if isinstance(val, (dict, list)) else str(val)
        elif t == "object":
            if not isinstance(val, dict):
                val = {}
        out[key] = val
    # UE requires every schema property to be present.
    for key, spec in props.items():
        if key not in out:
            out[key] = [] if spec.get("type") == "array" else ""
    return out


def extract_json(text):
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
        text = re.sub(r"\n?```$", "", text).strip()
    try:
        return json.loads(text)
    except Exception:
        pass
    m = re.search(r"\{.*\}", text, re.S)
    if m:
        try:
            return json.loads(m.group(0))
        except Exception:
            pass
    return None


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.rstrip("/").endswith("/models"):
            self._send(200, {"object": "list", "data": [{"id": "shim", "object": "model"}]})
        else:
            self._send(404, {"error": {"message": "not found"}})

    def do_POST(self):
        n = int(self.headers.get("Content-Length", "0"))
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            self._send(400, {"error": {"message": "bad json"}})
            return

        try:
            if "/embeddings" in self.path:
                # Local embedding server (llama.cpp) — it ignores "dimensions",
                # so UE must be configured with the server's real vector length.
                res = local_post(EMBED_URL, body)
                self._send(200, res)
                return

            if "/chat/completions" in self.path:
                schema = None
                rf = body.get("response_format") or {}
                if rf.get("type") == "json_schema" and isinstance(rf.get("json_schema"), dict):
                    schema = rf["json_schema"].get("schema")
                    body["response_format"] = {"type": "json_object"}
                    # Reinstate the schema as an instruction.
                    body["messages"] = list(body.get("messages", []))
                    body["messages"].insert(0, {
                        "role": "system",
                        "content": (
                            "You must answer with a single JSON object that matches this JSON Schema "
                            "exactly. Output ONLY the JSON object, no prose, no markdown fence.\n"
                            "Schema:\n" + json.dumps(schema, ensure_ascii=False)
                        ),
                    })
                res = upstream("/chat/completions", body)
                if schema is not None:
                    try:
                        content = res["choices"][0]["message"]["content"]
                        parsed = extract_json(content)
                        if parsed is None:
                            raise ValueError("no json")
                        fixed = coerce_to_schema(parsed, schema)
                        res["choices"][0]["message"]["content"] = json.dumps(fixed, ensure_ascii=False)
                    except Exception as e:
                        log("caption repair failed:", e)
                        res.setdefault("choices", [{"message": {"content": json.dumps(
                            {"tags": [], "caption": ""})}, "finish_reason": "stop"}])
                self._send(200, res)
                return

            self._send(404, {"error": {"message": "not found"}})
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")
            log("upstream error", e.code, detail[:300])
            self._send(e.code, {"error": {"message": detail[:300]}})
        except Exception as e:
            log("shim error:", repr(e))
            self._send(500, {"error": {"message": repr(e)}})


if __name__ == "__main__":
    log(f"shim up on 127.0.0.1:{PORT} upstream={UPSTREAM_BASE} embed_model={EMBED_MODEL}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
