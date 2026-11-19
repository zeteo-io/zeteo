-- AlterTable
ALTER TABLE "zeteo"."sources" ADD COLUMN     "last_sync_attempt_at" TIMESTAMP(3),
ADD COLUMN     "last_sync_error" JSONB,
ADD COLUMN     "sync_interval_minutes" INTEGER;

-- AlterTable
ALTER TABLE "zeteo"."source_tables" ADD COLUMN     "last_sync_attempt_at" TIMESTAMP(3),
ADD COLUMN     "last_sync_error" JSONB,
ADD COLUMN     "origin" JSONB;

-- AlterTable
ALTER TABLE "zeteo"."upload_stagings" ADD COLUMN     "vendor_file_id" TEXT;

-- CreateTable
CREATE TABLE "zeteo"."upload_claims" (
    "vendor" TEXT NOT NULL,
    "file_id" TEXT NOT NULL,
    "source_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "upload_claims_pkey" PRIMARY KEY ("vendor","file_id")
);

-- CreateTable
CREATE TABLE "zeteo"."connections" (
    "provider" TEXT NOT NULL,
    "sealed_settings" JSONB NOT NULL,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connections_pkey" PRIMARY KEY ("provider")
);

-- CreateIndex
CREATE INDEX "upload_claims_source_id_idx" ON "zeteo"."upload_claims"("source_id");

-- AddForeignKey
ALTER TABLE "zeteo"."upload_claims" ADD CONSTRAINT "upload_claims_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "zeteo"."sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

