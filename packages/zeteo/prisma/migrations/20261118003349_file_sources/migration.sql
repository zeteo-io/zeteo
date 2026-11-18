-- AlterEnum
ALTER TYPE "zeteo"."source_type" ADD VALUE 'upload';

-- AlterTable
ALTER TABLE "zeteo"."grants" ADD COLUMN     "owner_grant" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "zeteo"."source_columns" ADD COLUMN     "original_name" TEXT;

-- AlterTable
ALTER TABLE "zeteo"."source_tables" ADD COLUMN     "last_synced_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "zeteo"."sources" ADD COLUMN     "owner_id" UUID;

-- CreateTable
CREATE TABLE "zeteo"."file_stagings" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "preview" JSONB NOT NULL,
    "tables" JSONB NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_stagings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "file_stagings_expires_at_idx" ON "zeteo"."file_stagings"("expires_at");

-- CreateIndex
CREATE INDEX "file_stagings_owner_id_idx" ON "zeteo"."file_stagings"("owner_id");

-- CreateIndex
CREATE INDEX "sources_owner_id_idx" ON "zeteo"."sources"("owner_id");

-- A source has an owner exactly when it is a file source. Compared as text:
-- the enum value added above cannot be used in the transaction that adds it.
ALTER TABLE "zeteo"."sources" ADD CONSTRAINT "sources_owner_id_upload_check"
  CHECK (("owner_id" IS NOT NULL) = ("type"::text = 'upload'));
