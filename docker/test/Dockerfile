# syntax=docker/dockerfile:1
# Integration-test runner for Zeteo: dev dependencies installed, the sources
# copied, and the test suite as the command. Driven by docker/test/run.sh.
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/zeteo/package.json ./packages/zeteo/
COPY packages/zeteo-sdk/package.json ./packages/zeteo-sdk/
COPY packages/zeteo/prisma.config.ts ./packages/zeteo/
COPY packages/zeteo/prisma ./packages/zeteo/prisma/

RUN --mount=type=cache,target=/root/.npm,sharing=shared \
    npm ci --workspace=packages/zeteo

RUN cd packages/zeteo && npx prisma generate

COPY packages/zeteo ./packages/zeteo

WORKDIR /app/packages/zeteo

# globalSetup migrates the database itself.
CMD ["sh", "-c", "exec npx vitest run --project int ${TEST_SHARD:+--shard=$TEST_SHARD}"]
