#!/usr/bin/env bash
# Container entrypoint: wait for Postgres, migrate, seed (ORBOT_SEED), then start the API.
set -euo pipefail
cd /app

host="${ORBOT_DB_HOST:-db}"
port="${ORBOT_DB_PORT:-5432}"
echo "▸ Waiting for Postgres at ${host}:${port}…"
for _ in $(seq 1 60); do
  if (exec 3<>"/dev/tcp/${host}/${port}") 2>/dev/null; then exec 3>&-; break; fi
  sleep 1
done

echo "▸ Migrating…"
node apps/api/dist/src/db/migrate.js

echo "▸ Seeding (ORBOT_SEED=${ORBOT_SEED:-force}; skipped when the record already has units)…"
node apps/api/dist/src/seed/seed.cli.js

echo "▸ Starting ORBOT…"
exec node apps/api/dist/src/main.js
