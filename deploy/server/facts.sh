#!/usr/bin/env bash
# What a server is, as key=value lines for the Supply Depot. Runs as the login user; reads only.
set -u
# shellcheck source=/dev/null
. /etc/os-release 2>/dev/null
echo "os=${PRETTY_NAME:-unknown}"
echo "kernel=$(uname -r)"
echo "cpu=$(nproc 2>/dev/null) cores, $(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2 | sed 's/^ *//')"
echo "memory=$(free -g 2>/dev/null | awk '/^Mem:/ {print $2 " GB"}')"
echo "disk=$(df -h --output=avail / 2>/dev/null | tail -n 1 | tr -d ' ') free on /"
if command -v nvidia-smi >/dev/null 2>&1; then
  echo "gpu=$(nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader 2>/dev/null | paste -sd';' -)"
else
  echo "gpu=none (no nvidia-smi)"
fi
if command -v docker >/dev/null 2>&1; then
  echo "docker=$(docker --version 2>/dev/null | cut -d' ' -f3 | tr -d ,)"
else
  echo "docker=not installed"
fi
if sudo -n true 2>/dev/null; then echo "sudo=passwordless"; else echo "sudo=no"; fi
if command -v rsync >/dev/null 2>&1; then echo "rsync=yes"; else echo "rsync=no"; fi
