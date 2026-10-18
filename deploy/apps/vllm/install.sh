#!/usr/bin/env bash
# Install vLLM as the systemd service orbot-vllm: one Docker container serving MODEL on the
# GPU, OpenAI-compatible, every call needing VLLM_API_KEY. Safe to run again: it replaces the
# service with the current settings and keeps downloaded weights.
export APP=vllm
# shellcheck source=../../lib/common.sh
. "$(dirname "$(readlink -f "$0")")/../../lib/common.sh"
load_env

step "check the GPU"
ensure_gpu

step "Docker"
ensure_docker

step "NVIDIA Container Toolkit"
ensure_nvidia_toolkit

step "pull $IMAGE"
docker pull --quiet "$IMAGE"
docker image inspect --format 'image {{index .RepoDigests 0}}' "$IMAGE" || true

step "write the service"
install -d -m 755 "$ORBOT_STATE_DIR/hf-cache"
cat >/etc/systemd/system/orbot-vllm.service <<'UNIT'
[Unit]
Description=ORBOT app: vLLM
After=docker.service network-online.target
Wants=network-online.target
Requires=docker.service

[Service]
EnvironmentFile=/etc/orbot/apps/vllm.env
ExecStartPre=-/usr/bin/docker rm -f orbot-vllm
ExecStart=/opt/orbot/apps/vllm/run.sh
ExecStop=/usr/bin/docker stop orbot-vllm
Restart=on-failure
RestartSec=15
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload

step "start the service"
systemctl enable orbot-vllm
systemctl restart orbot-vllm

# The first start downloads the weights, which can take a long time on a slow line.
step "download $MODEL and load it on the GPU"
wait_healthy "http://127.0.0.1:${PORT}/health" orbot-vllm 80 orbot-vllm

step "check the API"
# The header goes in on stdin: a command line is readable by every user on the server.
printf 'Authorization: Bearer %s\n' "$VLLM_API_KEY" |
  curl -fsS -H @- "http://127.0.0.1:${PORT}/v1/models" >/dev/null ||
  fail "the API answered /health but refused /v1/models with the key"
nvidia-smi --query-gpu=name,memory.used,memory.total --format=csv,noheader

state "done"
echo "==> vLLM serves ${SERVED_NAME} on port ${PORT}"
