#!/usr/bin/env bash
# ExecStart of orbot-vllm. The settings come from the service's EnvironmentFile; the API key
# and the Hugging Face token pass into the container by name (-e NAME), never on a command
# line.
set -euo pipefail
# shellcheck disable=SC2086 # EXTRA_ARGS is a list of arguments.
exec /usr/bin/docker run --rm --name orbot-vllm \
  --gpus all --ipc=host \
  -p "${BIND}:${PORT}:8000" \
  -v /var/lib/orbot/apps/vllm/hf-cache:/root/.cache/huggingface \
  -e VLLM_API_KEY -e HF_TOKEN \
  "${IMAGE}" \
  --model "${MODEL}" \
  --served-model-name "${SERVED_NAME}" \
  --max-model-len "${MAX_MODEL_LEN}" \
  --gpu-memory-utilization "${GPU_MEMORY_UTILIZATION}" \
  --enable-auto-tool-choice --tool-call-parser "${TOOL_CALL_PARSER}" \
  ${EXTRA_ARGS}
