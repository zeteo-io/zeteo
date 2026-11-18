-- AlterEnum
ALTER TYPE "zeteo"."source_type" ADD VALUE 'google-sheets';

-- AlterTable
ALTER TABLE "zeteo"."sources" ADD COLUMN     "last_sync_attempt_at" TIMESTAMP(3),
ADD COLUMN     "last_sync_error" JSONB,
ADD COLUMN     "sync_interval_minutes" INTEGER,
ADD COLUMN     "vendor_file_id" TEXT;

-- AlterTable
ALTER TABLE "zeteo"."source_tables" ADD COLUMN     "vendor_locator" JSONB;

-- AlterTable
ALTER TABLE "zeteo"."upload_stagings" ADD COLUMN     "vendor_file_id" TEXT;

-- CreateTable
CREATE TABLE "zeteo"."connections" (
    "provider" TEXT NOT NULL,
    "sealed_settings" JSONB NOT NULL,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connections_pkey" PRIMARY KEY ("provider")
);


-- A spreadsheet is one live source at a time.
CREATE UNIQUE INDEX "sources_vendor_file_key" ON "zeteo"."sources" ("type", "vendor_file_id") WHERE "archived_at" IS NULL AND "vendor_file_id" IS NOT NULL;
