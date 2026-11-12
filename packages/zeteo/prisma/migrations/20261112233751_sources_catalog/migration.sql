-- CreateEnum
CREATE TYPE "zeteo"."source_type" AS ENUM ('postgres', 'azure-sql');

-- CreateEnum
CREATE TYPE "zeteo"."source_status" AS ENUM ('active', 'unreachable');

-- CreateEnum
CREATE TYPE "zeteo"."table_kind" AS ENUM ('table', 'view');

-- CreateEnum
CREATE TYPE "zeteo"."column_type" AS ENUM ('text', 'number', 'boolean', 'date', 'timestamp', 'json', 'other');

-- CreateEnum
CREATE TYPE "zeteo"."relation_origin" AS ENUM ('discovered', 'declared');

-- CreateTable
CREATE TABLE "zeteo"."sources" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "zeteo"."source_type" NOT NULL,
    "sealed_settings" JSONB NOT NULL,
    "schemas" TEXT[],
    "timeout_ms" INTEGER NOT NULL DEFAULT 30000,
    "row_cap" INTEGER NOT NULL DEFAULT 50000,
    "export_enabled" BOOLEAN NOT NULL DEFAULT false,
    "export_row_cap" INTEGER NOT NULL DEFAULT 0,
    "writable_login_allowed" BOOLEAN NOT NULL DEFAULT false,
    "status" "zeteo"."source_status" NOT NULL DEFAULT 'active',
    "last_refreshed_at" TIMESTAMP(3),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zeteo"."source_tables" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "schema_name" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "zeteo"."table_kind" NOT NULL,
    "description" TEXT,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "missing_since" TIMESTAMP(3),

    CONSTRAINT "source_tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zeteo"."source_columns" (
    "id" UUID NOT NULL,
    "table_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "zeteo"."column_type" NOT NULL,
    "native_type" TEXT NOT NULL,
    "nullable" BOOLEAN NOT NULL,
    "position" INTEGER NOT NULL,
    "is_primary_key" BOOLEAN NOT NULL,
    "description" TEXT,
    "missing_since" TIMESTAMP(3),

    CONSTRAINT "source_columns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zeteo"."relations" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "from_table_id" UUID NOT NULL,
    "from_columns" TEXT[],
    "to_table_id" UUID NOT NULL,
    "to_columns" TEXT[],
    "to_many" BOOLEAN NOT NULL,
    "origin" "zeteo"."relation_origin" NOT NULL,
    "constraint_name" TEXT,
    "missing_since" TIMESTAMP(3),
    "created_by" UUID,

    CONSTRAINT "relations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sources_slug_key" ON "zeteo"."sources"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "source_tables_source_id_schema_name_name_key" ON "zeteo"."source_tables"("source_id", "schema_name", "name");

-- CreateIndex
CREATE UNIQUE INDEX "source_columns_table_id_name_key" ON "zeteo"."source_columns"("table_id", "name");

-- CreateIndex
CREATE INDEX "relations_source_id_idx" ON "zeteo"."relations"("source_id");

-- CreateIndex
CREATE INDEX "relations_to_table_id_idx" ON "zeteo"."relations"("to_table_id");

-- CreateIndex
CREATE UNIQUE INDEX "relations_from_table_id_name_key" ON "zeteo"."relations"("from_table_id", "name");

-- AddForeignKey
ALTER TABLE "zeteo"."source_tables" ADD CONSTRAINT "source_tables_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "zeteo"."sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zeteo"."source_columns" ADD CONSTRAINT "source_columns_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "zeteo"."source_tables"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zeteo"."relations" ADD CONSTRAINT "relations_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "zeteo"."sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zeteo"."relations" ADD CONSTRAINT "relations_from_table_id_fkey" FOREIGN KEY ("from_table_id") REFERENCES "zeteo"."source_tables"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zeteo"."relations" ADD CONSTRAINT "relations_to_table_id_fkey" FOREIGN KEY ("to_table_id") REFERENCES "zeteo"."source_tables"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CHECK constraints: Prisma cannot express them.
ALTER TABLE "zeteo"."sources"
    ADD CONSTRAINT "sources_slug_format_check" CHECK ("slug" ~ '^[a-z][a-z0-9-]{1,62}$'),
    ADD CONSTRAINT "sources_row_cap_check" CHECK ("row_cap" BETWEEN 1 AND 50000),
    ADD CONSTRAINT "sources_export_row_cap_check" CHECK ("export_row_cap" BETWEEN 0 AND 1000000),
    ADD CONSTRAINT "sources_timeout_ms_check" CHECK ("timeout_ms" BETWEEN 1000 AND 120000);

ALTER TABLE "zeteo"."relations"
    ADD CONSTRAINT "relations_columns_match_check" CHECK (cardinality("from_columns") = cardinality("to_columns") AND cardinality("from_columns") >= 1);
