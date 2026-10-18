# syntax=docker/dockerfile:1
#
# Multi-stage build. The runtime image carries compiled JavaScript and the
# Prisma engines only — no TypeScript toolchain, no source, no npm cache.

# --- deps -------------------------------------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app

# openssl is required by the Prisma query engine at runtime.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY packages ./packages

# `npm ci` needs the lockfile and every workspace manifest present, because
# postinstall runs `prisma generate` against the real schema.
RUN npm ci --include=dev

# --- build ------------------------------------------------------------------
FROM deps AS build
WORKDIR /app
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm run build:packages

# Drop dev dependencies from node_modules in place for the runtime stage.
RUN npm prune --omit=dev

# --- runtime ----------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=3000 \
    NODE_OPTIONS=--enable-source-maps

# Run unprivileged. The node image ships a `node` user (uid 1000).
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/scripts ./scripts

USER node
EXPOSE 3000

# Readiness reports degraded for an impaired-but-serving process, so a failing
# probe here means the process genuinely cannot serve traffic.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT}/v1/health/ready || exit 1

# Node handles SIGTERM; main.ts enables shutdown hooks so Prisma's pool closes.
STOPSIGNAL SIGTERM

CMD ["node", "dist/main.js"]