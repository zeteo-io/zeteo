-- AlterTable
ALTER TABLE "zeteo"."measures" ADD COLUMN     "date_column" TEXT,
ADD COLUMN     "fixed" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "zeteo"."metrics" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "formula" JSONB NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "metrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "metrics_source_id_name_key" ON "zeteo"."metrics"("source_id", "name");

-- AddForeignKey
ALTER TABLE "zeteo"."metrics" ADD CONSTRAINT "metrics_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "zeteo"."sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A metric's description is required and at most 2,000 characters.
ALTER TABLE "zeteo"."metrics" ADD CONSTRAINT "metrics_description_length" CHECK (char_length("description") BETWEEN 1 AND 2000);
