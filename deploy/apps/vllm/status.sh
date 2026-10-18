#!/usr/bin/env bash
# How vLLM is doing, as key=value lines for ORBOT. Never prints a secret.
export APP=vllm
# shellcheck source=../../lib/common.sh
. "$(dirname "$(readlink -f "$0")")/../../lib/common.sh"
trap - ERR
set +e
load_env

echo "service=$(systemctl is-active orbot-vllm 2>/dev/null)"
if curl -fsS -o /dev/null --max-time 5 "http://127.0.0.1:${PORT}/health"; then
  echo "health=ok"
else
  echo "health=down"
fi
# The header goes in on stdin: a command line is readable by every user on the server.
models=$(printf 'Authorization: Bearer %s\n' "$VLLM_API_KEY" |
  curl -fsS --max-time 5 -H @- "http://127.0.0.1:${PORT}/v1/models" | grep -o '"id":"[^"]*"' | cut -d'"' -f4 | paste -sd, -)
echo "models=${models}"
echo "image=$(docker inspect --format '{{.Image}}' orbot-vllm 2>/dev/null)"
echo "gpu=$(nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu --format=csv,noheader 2>/dev/null | head -n 1)"
exit 0
