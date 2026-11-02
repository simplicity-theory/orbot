#!/usr/bin/env bash
# Disk space for the health check: one `disk=<mount>|<size>|<used>|<avail>` line (bytes) per
# filesystem holding something ORBOT cares about: the system, homes (bot folders), Docker's
# images and ORBOT's app data (model weights). Runs as the login user; reads only.
set -u
seen=" "
for p in / /home /var/lib/docker /var/lib/orbot; do
  [ -e "$p" ] || continue
  line=$(df -P -B1 "$p" 2>/dev/null | tail -n 1) || continue
  [ -n "$line" ] || continue
  dev=$(echo "$line" | awk '{print $1}')
  case "$seen" in *" $dev "*) continue ;; esac
  seen="$seen$dev "
  echo "$line" | awk '{printf "disk=%s|%s|%s|%s\n", $6, $2, $3, $4}'
done
