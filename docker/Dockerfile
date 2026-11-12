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
COPY packages/zeteo/prisma.config.ts ./packages/zeteo/
COPY packages/zeteo/prisma ./packages/zeteo/prisma/

RUN --mount=type=cache,target=/root/.npm,sharing=shared \
    npm ci --workspace=packages/zeteo

RUN cd packages/zeteo && npx prisma generate

COPY packages/zeteo/tsconfig.json ./packages/zeteo/
COPY packages/zeteo/src ./packages/zeteo/src

RUN npx tsc -p packages/zeteo

# ---------------------------------------------------------------------------
# Runtime: production dependencies and compiled output only.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime

WORKDIR /app

# dumb-init for signal handling, wget for the health check.
RUN apk add --no-cache dumb-init wget

COPY package.json package-lock.json ./
COPY packages/zeteo/package.json ./packages/zeteo/
COPY packages/zeteo/prisma.config.ts ./packages/zeteo/
COPY packages/zeteo/prisma ./packages/zeteo/prisma/

RUN --mount=type=cache,target=/root/.npm,sharing=shared \
    npm ci --workspace=packages/zeteo --omit=dev

RUN cd packages/zeteo && npx prisma generate

COPY --from=build /app/packages/zeteo/dist ./packages/zeteo/dist

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
