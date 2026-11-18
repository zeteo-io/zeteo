-- AlterEnum
ALTER TYPE "zeteo"."source_type" ADD VALUE 'upload';

-- AlterTable
ALTER TABLE "zeteo"."grants" ADD COLUMN     "owner_grant" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "zeteo"."source_columns" ADD COLUMN     "original_name" TEXT;

-- AlterTable
ALTER TABLE "zeteo"."source_tables" ADD COLUMN     "last_synced_at" TIMESTAMP(3),
ADD COLUMN     "row_count" BIGINT;

-- AlterTable
ALTER TABLE "zeteo"."sources" ADD COLUMN     "owner_id" UUID,
ADD COLUMN     "size_bytes" BIGINT,
ADD COLUMN     "size_measured_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "zeteo"."upload_stagings" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "preview" JSONB NOT NULL,
    "tables" JSONB NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "upload_stagings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "upload_stagings_expires_at_idx" ON "zeteo"."upload_stagings"("expires_at");

-- CreateIndex
CREATE INDEX "upload_stagings_owner_id_idx" ON "zeteo"."upload_stagings"("owner_id");

-- CreateIndex
CREATE INDEX "sources_owner_id_idx" ON "zeteo"."sources"("owner_id");

-- A source has an owner exactly when it is an upload source. Compared as text:
-- the enum value added above cannot be used in the transaction that adds it.
ALTER TABLE "zeteo"."sources" ADD CONSTRAINT "sources_owner_id_upload_check"
  CHECK (("owner_id" IS NOT NULL) = ("type"::text = 'upload'));

-- Uploads' staging tables: raw text of an upload awaiting its load.
-- Outside Prisma's schemas, so Prisma neither models nor diffs it; Zeteo
-- creates and drops its tables with raw SQL. Nothing is granted on it: only
-- Zeteo's own login reads it, never the uploads reader role.
CREATE SCHEMA IF NOT EXISTS "zeteo_upload_staging";
