-- AlterTable
ALTER TABLE "zeteo"."sources" ADD COLUMN     "size_bytes" BIGINT,
ADD COLUMN     "size_measured_at" TIMESTAMP(3);
