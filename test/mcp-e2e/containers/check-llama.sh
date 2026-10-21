#!/usr/bin/env bash
# check-llama.sh <base-url> [label] - runs INSIDE a vscode-mcp-build:2 container.
# Verifies a llama.cpp OpenAI-compatible server: GET /v1/models and a /v1/chat/completions
# request with one tool definition whose answer must contain a tool_calls entry.
# Writes /out/logs/llama-<label>-*.json.
set -euo pipefail
BASE="${1:?base url, e.g. http://llama-e2e:8080}"
LABEL="${2:-check}"
OUT=/out/logs
mkdir -p "$OUT"

echo "== $LABEL: $BASE"
getent hosts "$(echo "$BASE" | sed -E 's#^https?://([^:/]+).*#\1#')" || true

t0=$(date +%s%N)
curl -fsS --max-time 10 "$BASE/health" && echo
curl -fsS --max-time 10 "$BASE/v1/models" | tee "$OUT/llama-$LABEL-models.json" | jq -c '{models: [.data[].id]}'
echo "models: $(( ($(date +%s%N) - t0) / 1000000 )) ms"

cat > /tmp/req.json <<'EOF'
{
	"model": "Qwen3-8B-Q4_K_M.gguf",
	"messages": [
		{ "role": "system", "content": "You are a helpful assistant. Use the provided tools when they can answer the question." },
		{ "role": "user", "content": "What is the weather in Paris right now? /no_think" }
	],
	"tools": [{
		"type": "function",
		"function": {
			"name": "get_weather",
			"description": "Get the current weather for a city",
			"parameters": {
				"type": "object",
				"properties": { "city": { "type": "string", "description": "City name" } },
				"required": ["city"]
			}
		}
	}],
	"tool_choice": "auto",
	"temperature": 0,
	"max_tokens": 512
}
EOF
t0=$(date +%s%N)
curl -fsS --max-time 180 -H 'content-type: application/json' --data @/tmp/req.json "$BASE/v1/chat/completions" > "$OUT/llama-$LABEL-chat.json"
ms=$(( ($(date +%s%N) - t0) / 1000000 ))
jq -c '{finish_reason: .choices[0].finish_reason, tool_calls: .choices[0].message.tool_calls, content: .choices[0].message.content, usage: .usage, timings: (.timings | {prompt_ms, predicted_ms, predicted_per_second})}' "$OUT/llama-$LABEL-chat.json"
echo "chat/completions: $ms ms"
jq -e '.choices[0].message.tool_calls | length > 0' "$OUT/llama-$LABEL-chat.json" > /dev/null
jq -e '.choices[0].message.tool_calls[0].function.name == "get_weather"' "$OUT/llama-$LABEL-chat.json" > /dev/null
echo "== $LABEL: OK (tool_calls present)"
