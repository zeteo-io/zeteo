-- CreateEnum
CREATE TYPE "zeteo"."principal_type" AS ENUM ('user', 'group');

-- CreateEnum
CREATE TYPE "zeteo"."entry_point" AS ENUM ('api', 'mcp', 'export');

-- CreateEnum
CREATE TYPE "zeteo"."run_outcome" AS ENUM ('ok', 'refused', 'failed', 'timeout');

-- CreateTable
CREATE TABLE "zeteo"."grants" (
    "id" UUID NOT NULL,
    "principal_type" "zeteo"."principal_type" NOT NULL,
    "principal_id" UUID NOT NULL,
    "table_id" UUID NOT NULL,
    "all_columns" BOOLEAN NOT NULL,
    "row_filter" JSONB,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zeteo"."grant_columns" (
    "grant_id" UUID NOT NULL,
    "column_id" UUID NOT NULL,

    CONSTRAINT "grant_columns_pkey" PRIMARY KEY ("grant_id","column_id")
);

-- CreateTable
CREATE TABLE "zeteo"."query_runs" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "source_id" UUID,
    "entry_point" "zeteo"."entry_point" NOT NULL,
    "query" JSONB NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "row_count" INTEGER,
    "outcome" "zeteo"."run_outcome" NOT NULL,
    "error_code" TEXT,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "query_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "grants_table_id_idx" ON "zeteo"."grants"("table_id");

-- CreateIndex
CREATE UNIQUE INDEX "grants_principal_type_principal_id_table_id_key" ON "zeteo"."grants"("principal_type", "principal_id", "table_id");

-- CreateIndex
CREATE INDEX "query_runs_user_id_id_idx" ON "zeteo"."query_runs"("user_id", "id");

-- CreateIndex
CREATE INDEX "query_runs_source_id_id_idx" ON "zeteo"."query_runs"("source_id", "id");

-- AddForeignKey
ALTER TABLE "zeteo"."grants" ADD CONSTRAINT "grants_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "zeteo"."source_tables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zeteo"."grant_columns" ADD CONSTRAINT "grant_columns_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "zeteo"."grants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zeteo"."grant_columns" ADD CONSTRAINT "grant_columns_column_id_fkey" FOREIGN KEY ("column_id") REFERENCES "zeteo"."source_columns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zeteo"."query_runs" ADD CONSTRAINT "query_runs_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "zeteo"."sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CHECK constraint: Prisma cannot express it. Row filters are reserved.
ALTER TABLE "zeteo"."grants"
    ADD CONSTRAINT "grants_row_filter_reserved_check" CHECK ("row_filter" IS NULL);
