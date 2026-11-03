#!/usr/bin/env bash
# Restore a backup made by scripts/backup.sh into a production ORBOT.
#   scripts/restore.sh <backup-dir>
# Stops the API, replaces BOTH databases and the workspaces volume with the backup, starts the
# API again. Everything written after the backup is lost: this is the one operation in ORBOT
# that throws records away, which is why it asks twice.
set -euo pipefail
cd "$(dirname "$0")/.."
compose=(docker compose -f docker-compose.prod.yml)
src="${1:?usage: scripts/restore.sh <backup-dir>}"
for f in record.dump secrets.dump workspaces.tar.gz; do
  [[ -f "$src/$f" ]] || { echo "✖ $src/$f is missing"; exit 1; }
done

set -a; # shellcheck disable=SC1091
source .env; set +a
: "${ORBOT_DB_NAME:=orbot}" "${ORBOT_SECRETS_DB_NAME:=orbot_secrets}"
[[ -n "${ORBOT_SECRETS_KEY:-}" ]] || { echo "✖ ORBOT_SECRETS_KEY is not set in .env; the restored secrets would be unreadable."; exit 1; }

echo "This replaces the record ($ORBOT_DB_NAME), the secrets store ($ORBOT_SECRETS_DB_NAME)"
echo "and the workspaces volume with $src. Everything written since that backup is lost."
read -r -p "Type the word restore to continue: " answer
[[ "$answer" == "restore" ]] || { echo "Nothing done."; exit 1; }
read -r -p "Is ORBOT_SECRETS_KEY in .env the same key the backup was made with? (yes/no) " same
[[ "$same" == "yes" ]] || { echo "Put the key that goes with the backup in .env first. Nothing done."; exit 1; }

echo "▸ Stopping the API…"
"${compose[@]}" stop api
"${compose[@]}" up -d --wait db

restore_db() {
  local db="$1" dump="$2"
  echo "▸ Restoring $db…"
  "${compose[@]}" exec -T db psql -U orbot_admin -d postgres -v ON_ERROR_STOP=1 -q \
    -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$db' AND pid <> pg_backend_pid();" >/dev/null
  "${compose[@]}" exec -T db pg_restore -U orbot_admin --dbname "$db" --clean --if-exists --no-owner --no-privileges < "$dump" \
    || echo "  (pg_restore reported errors above; usually harmless 'does not exist' notices from --clean)"
}
restore_db "$ORBOT_DB_NAME" "$src/record.dump"
restore_db "$ORBOT_SECRETS_DB_NAME" "$src/secrets.dump"

echo "▸ Restoring workspaces…"
"${compose[@]}" run --rm --no-deps --entrypoint sh api -c 'rm -rf /app/workspaces/* && tar -C /app/workspaces -xzf -' < "$src/workspaces.tar.gz"

echo "▸ Starting the API (migrations run on start)…"
"${compose[@]}" up -d api
echo "✔ Restored from $src"
