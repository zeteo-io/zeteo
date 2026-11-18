# syntax=docker/dockerfile:1
#
# Zeteo. Builds from source; run from the repo root:
#
#   docker build -f docker/Dockerfile -t zeteo .
#
# The same image runs `./migrate.sh` as the migrate step (compose's `migrate`
# service, or a Kubernetes Job).

# ---------------------------------------------------------------------------
# Build: the service, compiled with dev dependencies.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/zeteo/package.json ./packages/zeteo/
COPY packages/zeteo-sdk/package.json ./packages/zeteo-sdk/
COPY packages/zeteo-ui/package.json ./packages/zeteo-ui/
COPY packages/zeteo/prisma.config.ts ./packages/zeteo/
COPY packages/zeteo/prisma ./packages/zeteo/prisma/

RUN --mount=type=cache,target=/root/.npm,sharing=shared \
    npm ci --workspace=packages/zeteo

RUN cd packages/zeteo && npx prisma generate

COPY packages/zeteo/tsconfig.json ./packages/zeteo/
COPY packages/zeteo/src ./packages/zeteo/src

RUN npx tsc -p packages/zeteo

# ---------------------------------------------------------------------------
# UI: the admin UI's static build. Only its dist/ reaches the runtime image.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS ui

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/zeteo/package.json ./packages/zeteo/
COPY packages/zeteo-sdk/package.json ./packages/zeteo-sdk/
COPY packages/zeteo-ui/package.json ./packages/zeteo-ui/

RUN --mount=type=cache,target=/root/.npm,sharing=shared \
    npm ci --workspace=packages/zeteo-ui

COPY packages/zeteo-ui/index.html packages/zeteo-ui/tsconfig.json packages/zeteo-ui/vite.config.ts ./packages/zeteo-ui/
# The MCP preview card, built by the same `build` to dist-mcp/card.html.
COPY packages/zeteo-ui/mcp-card.html packages/zeteo-ui/vite.mcp-card.config.ts ./packages/zeteo-ui/
COPY packages/zeteo-ui/public ./packages/zeteo-ui/public/
COPY packages/zeteo-ui/src ./packages/zeteo-ui/src/

RUN npm run build --workspace=packages/zeteo-ui

# ---------------------------------------------------------------------------
# Runtime: production dependencies and compiled output only.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime

WORKDIR /app

# dumb-init for signal handling, wget for the health check.
RUN apk add --no-cache dumb-init wget

COPY package.json package-lock.json ./
COPY packages/zeteo/package.json ./packages/zeteo/
COPY packages/zeteo-sdk/package.json ./packages/zeteo-sdk/
COPY packages/zeteo-ui/package.json ./packages/zeteo-ui/
COPY packages/zeteo/prisma.config.ts ./packages/zeteo/
COPY packages/zeteo/prisma ./packages/zeteo/prisma/

RUN --mount=type=cache,target=/root/.npm,sharing=shared \
    npm ci --workspace=packages/zeteo --omit=dev

RUN cd packages/zeteo && npx prisma generate

COPY --from=build /app/packages/zeteo/dist ./packages/zeteo/dist

# Served at / when UI_CLIENT_ID is set (UI_DIST_PATH's default). Root-owned
# and world-readable: the service only reads it.
COPY --from=ui --chmod=a+rX /app/packages/zeteo-ui/dist ./packages/zeteo-ui/dist
# The MCP preview card (MCP_CARD_PATH's default), read once at start.
COPY --from=ui --chmod=a+rX /app/packages/zeteo-ui/dist-mcp ./packages/zeteo-ui/dist-mcp

COPY docker/migrate.sh ./packages/zeteo/

RUN chmod +x packages/zeteo/migrate.sh && \
    addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app/packages/zeteo

USER nodejs

WORKDIR /app/packages/zeteo

# Production unless overridden: JSON logs, and the PUBLIC_URL / TRUST_PROXY
# checks. docker-compose.yml sets development for its localhost stack.
ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget --quiet --tries=1 --spider "http://localhost:${PORT:-4201}/health" || exit 1

EXPOSE 4201

ENTRYPOINT ["dumb-init", "--"]

CMD ["node", "dist/index.js"]
