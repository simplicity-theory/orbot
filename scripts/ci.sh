#!/usr/bin/env bash
# Everything CI runs, in order. Needs Docker (for Postgres) and Playwright's Chromium.
#   npm run ci
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }

step "Install"
npm ci --no-audit --no-fund

step "Build shared package"
npm run build -w @orbot/shared

step "Lint"
npx oxlint packages apps --ignore-pattern '**/dist/**' --ignore-pattern '**/.angular/**'
node scripts/check-tokens.mjs

step "Format check"
npx prettier --check .

step "Server scripts (deploy/)"
docker run --rm -v "$PWD:/mnt:ro" -w /mnt koalaman/shellcheck:v0.10.0 -x \
  deploy/lib/common.sh deploy/apps/*/*.sh deploy/server/*.sh deploy/orbot/*.sh \
  scripts/orbot scripts/backup.sh scripts/restore.sh

step "Typecheck"
npm run typecheck -w @orbot/shared
npm run typecheck -w @orbot/api
npm run typecheck -w @orbot/web

step "Unit tests"
npm run test -w @orbot/shared
npm run test -w @orbot/api
npm run test -w @orbot/web

step "Start Postgres"
docker compose up -d --wait db

step "API e2e (record, secrets, Overseer, briefing, curation, docs, cold-start, phase done-when tests)"
npm run test:e2e -w @orbot/api

step "Production build"
npm run build -w @orbot/api
npm run build -w @orbot/web

step "UI tests (Playwright + axe)"
npx --workspace @orbot/web playwright install chromium >/dev/null
npm run test:ui -w @orbot/web

if [[ "${ORBOT_CI_DOCKER:-0}" == "1" ]]; then
  step "Docker image (ORBOT_CI_DOCKER=1)"
  docker build -t orbot:ci .
fi

printf '\n\033[1;32m✔ CI passed\033[0m\n'
