#!/usr/bin/env bash
# Set up the bot workspace: a Linux user for bots' dev work, without sudo and outside the
# docker group, so a bot cannot stop or change the apps on this server. It may use the GPU.
# ORBOT runs this as root with WORKSPACE_USER and PUBLIC_KEY (the user's only login key)
# exported ahead of it on stdin.
set -euo pipefail
: "${WORKSPACE_USER:?}" "${PUBLIC_KEY:?}"

if ! id -u "$WORKSPACE_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$WORKSPACE_USER"
  echo "created user $WORKSPACE_USER"
fi
for g in sudo admin wheel docker; do
  if id -nG "$WORKSPACE_USER" | tr ' ' '\n' | grep -qx "$g"; then
    gpasswd -d "$WORKSPACE_USER" "$g" >/dev/null
    echo "removed $WORKSPACE_USER from $g"
  fi
done
for g in video render; do
  getent group "$g" >/dev/null && usermod -aG "$g" "$WORKSPACE_USER"
done

home=$(getent passwd "$WORKSPACE_USER" | cut -d: -f6)
install -d -m 700 -o "$WORKSPACE_USER" -g "$WORKSPACE_USER" "$home/.ssh"
printf '%s\n' "$PUBLIC_KEY" >"$home/.ssh/authorized_keys"
chown "$WORKSPACE_USER:$WORKSPACE_USER" "$home/.ssh/authorized_keys"
chmod 600 "$home/.ssh/authorized_keys"
install -d -m 755 -o "$WORKSPACE_USER" -g "$WORKSPACE_USER" "$home/orbot-dev"

if command -v rsync >/dev/null 2>&1; then echo "rsync=yes"; else echo "rsync=no"; fi
echo "orbot-workspace-ok"
