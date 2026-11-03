# ORBOT: API + built web app in one image. See docs/deploy.md.
#   docker compose -f docker-compose.prod.yml up -d --build

# ---- 1. Install every dependency and build the three workspaces ----
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY apps/web apps/web
RUN npm run build -w @orbot/shared \
  && npm run build -w @orbot/api \
  && npm run build -w @orbot/web

# ---- 2. Production dependencies only ----
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ---- 3. Runtime ----
FROM node:24-bookworm-slim
# The commit the image was built from (scripts/orbot passes it); shown by /api/health.
ARG ORBOT_COMMIT=
ENV ORBOT_COMMIT=$ORBOT_COMMIT \
    NODE_ENV=production \
    ORBOT_ROOT=/app \
    ORBOT_WEB_DIST=/app/apps/web/dist/web/browser \
    ORBOT_WORKSPACES_DIR=/app/workspaces \
    ORBOT_DEPLOY_DIR=/app/deploy \
    ORBOT_TRUST_PROXY=on \
    ORBOT_SEED=force
# Bots need git (worktrees), ssh and rsync (servers); tini reaps their child processes.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git openssh-client rsync ca-certificates tini curl \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 1001 orbot && useradd --uid 1001 --gid orbot --create-home --shell /bin/bash orbot
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/api/package.json apps/api/
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/web/dist apps/web/dist
COPY deploy deploy
# Writable by whoever the container runs as (compose maps it to the operator's uid, D123).
RUN mkdir -p /app/workspaces && chown -R orbot:orbot /app/workspaces /app/deploy /home/orbot \
  && chmod -R a+rwX /app/workspaces /app/deploy /home/orbot \
  && chmod +x /app/deploy/orbot/entrypoint.sh
USER orbot
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS http://localhost:3000/api/health >/dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "/app/deploy/orbot/entrypoint.sh"]
