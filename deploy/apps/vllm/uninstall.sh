#!/usr/bin/env bash
# Stop and remove the orbot-vllm service and its container. Downloaded weights stay in
# /var/lib/orbot/apps/vllm/hf-cache, so a reinstall does not download them again.
export APP=vllm
# shellcheck source=../../lib/common.sh
. "$(dirname "$(readlink -f "$0")")/../../lib/common.sh"

step "stop the service"
systemctl disable --now orbot-vllm 2>/dev/null || true
docker rm -f orbot-vllm 2>/dev/null || true
rm -f /etc/systemd/system/orbot-vllm.service
systemctl daemon-reload

state removed
echo "==> vLLM removed (weights kept in $ORBOT_STATE_DIR/hf-cache)"
