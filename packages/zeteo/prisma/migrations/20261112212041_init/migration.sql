-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "core";

-- CreateSchema
-- Prisma emits a schema only with its first object; the zeteo schema has none yet.
CREATE SCHEMA IF NOT EXISTS "zeteo";

-- CreateTable
CREATE TABLE "core"."core_outbox" (
    "id" UUID NOT NULL,
    "destination" VARCHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "traceparent" VARCHAR(64),
    "tracestate" VARCHAR(512),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_at" TIMESTAMP(3),
    "claimed_by" VARCHAR(255),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" VARCHAR(1000),
    "dead_lettered_at" TIMESTAMP(3),

    CONSTRAINT "core_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- The reaper's pending-rows index, as @tereo-io/sdk's outboxTableSql: Prisma cannot express a partial index.
CREATE INDEX "core_outbox_pending_idx" ON "core"."core_outbox" ("next_attempt_at") WHERE "dead_lettered_at" IS NULL;
