#!/usr/bin/env bash
# Back up a production ORBOT: both databases (record and secrets) and the repository clones.
#   scripts/backup.sh [backup-dir]      (default: ./backups/<date>)
# Restore with scripts/restore.sh. Keep ORBOT_SECRETS_KEY from .env with the backup: the
# secrets dump is useless without it.
set -euo pipefail
cd "$(dirname "$0")/.."
compose=(docker compose -f docker-compose.prod.yml)
out="${1:-backups/$(date +%Y-%m-%d_%H%M%S)}"
mkdir -p "$out"

set -a; # shellcheck disable=SC1091
source .env; set +a
: "${ORBOT_DB_NAME:=orbot}" "${ORBOT_SECRETS_DB_NAME:=orbot_secrets}"

echo "▸ Dumping the record ($ORBOT_DB_NAME)…"
"${compose[@]}" exec -T db pg_dump -U orbot_admin --format=custom "$ORBOT_DB_NAME" > "$out/record.dump"
echo "▸ Dumping the secrets store ($ORBOT_SECRETS_DB_NAME)…"
"${compose[@]}" exec -T db pg_dump -U orbot_admin --format=custom "$ORBOT_SECRETS_DB_NAME" > "$out/secrets.dump"
echo "▸ Archiving repository clones and published sites (workspaces volume)…"
"${compose[@]}" exec -T api tar -C /app/workspaces -czf - --exclude=tasks --exclude=integration . > "$out/workspaces.tar.gz"

chmod 600 "$out"/*
cat <<MSG

✔ Backup written to $out
  record.dump         the permanent record
  secrets.dump        the secrets store (encrypted at rest; needs ORBOT_SECRETS_KEY)
  workspaces.tar.gz   repository clones, unit document mirrors, published sites

Keep safe, apart from the server: this folder AND the ORBOT_SECRETS_KEY line of .env.
MSG
