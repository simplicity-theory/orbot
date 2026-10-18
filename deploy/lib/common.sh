#!/usr/bin/env bash
# Shared helpers for ORBOT app scripts. Sourced by an app's install/uninstall/status script,
# never run on its own. ORBOT copies deploy/lib and deploy/apps/<app> to /opt/orbot on the
# server and runs the scripts as root (installs under systemd-run, so they outlive the SSH
# session). It follows an install by reading the state file this library writes.
set -Eeuo pipefail

: "${APP:?APP must be set before sourcing common.sh}"
ORBOT_ENV_DIR=/etc/orbot/apps
ORBOT_STATE_DIR=/var/lib/orbot/apps/$APP
CURRENT_STEP=start

# One line ORBOT reads: "running <step>", "done", "failed <step>: <why>" or "removed".
state() {
  install -d -m 755 "$ORBOT_STATE_DIR"
  printf '%s\n' "$*" >"$ORBOT_STATE_DIR/state.tmp"
  mv "$ORBOT_STATE_DIR/state.tmp" "$ORBOT_STATE_DIR/state"
}

step() {
  CURRENT_STEP="$1"
  state "running $1"
  echo "==> $(date -u +%H:%M:%S) $1"
}

fail() {
  trap - ERR
  echo "ERROR: $*" >&2
  state "failed ${CURRENT_STEP}: $*"
  exit 1
}

# Any failing command ends the run with the step it was in. BASH_COMMAND is the command as
# written (variables unexpanded), so no setting's value is echoed here.
trap 'fail "a command failed (line $LINENO): $BASH_COMMAND"' ERR

# The app's settings and secrets, written by ORBOT (root-only, mode 600).
load_env() {
  local f="$ORBOT_ENV_DIR/$APP.env"
  [[ -r $f ]] || fail "no settings at $f"
  set -a
  # shellcheck source=/dev/null
  . "$f"
  set +a
}

export DEBIAN_FRONTEND=noninteractive

# The NVIDIA driver must be there already: installing one needs a reboot, so ORBOT does not.
ensure_gpu() {
  if ! command -v nvidia-smi >/dev/null 2>&1 || ! nvidia-smi -L >/dev/null 2>&1; then
    fail "no working NVIDIA driver (nvidia-smi). Install one with 'sudo ubuntu-drivers install', reboot, then install again"
  fi
  nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader
}

ensure_docker() {
  if command -v docker >/dev/null 2>&1; then
    docker --version
    systemctl is-active --quiet docker || systemctl enable --now docker
    return
  fi
  echo "Docker is not installed: installing Docker Engine from download.docker.com"
  apt-get update -q
  apt-get install -y -q ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  # shellcheck source=/dev/null
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${UBUNTU_CODENAME:-$VERSION_CODENAME} stable" \
    >/etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
  docker --version
}

# Lets containers use the GPU (docker run --gpus all).
ensure_nvidia_toolkit() {
  if ! command -v nvidia-ctk >/dev/null 2>&1; then
    echo "The NVIDIA Container Toolkit is not installed: installing it from nvidia.github.io"
    apt-get update -q
    apt-get install -y -q ca-certificates curl gnupg
    curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey |
      gpg --batch --yes --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
    curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list |
      sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
        >/etc/apt/sources.list.d/nvidia-container-toolkit.list
    apt-get update -q
    apt-get install -y -q nvidia-container-toolkit
  fi
  if ! docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q nvidia; then
    nvidia-ctk runtime configure --runtime=docker
    systemctl restart docker
  fi
  nvidia-ctk --version | head -n 1
}

# Wait until a URL answers, while the service behind it stays up. Prints progress.
wait_healthy() {
  local url=$1 service=$2 minutes=$3 container=${4:-}
  local deadline=$((SECONDS + minutes * 60)) next_note=0
  until curl -fsS -o /dev/null "$url"; do
    if ! systemctl is-active --quiet "$service"; then
      journalctl -u "$service" -n 40 --no-pager -o cat || true
      fail "$service stopped before it answered (its last lines are above)"
    fi
    if ((SECONDS >= deadline)); then
      fail "$service did not answer at $url within $minutes minutes"
    fi
    if ((SECONDS >= next_note)); then
      echo "... waiting for $url"
      if [[ -n $container ]]; then
        docker logs --tail 2 "$container" 2>&1 | sed 's/^/    /' || true
      fi
      next_note=$((SECONDS + 30))
    fi
    sleep 5
  done
}
