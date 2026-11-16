-- AlterTable
ALTER TABLE "zeteo"."sources" ADD COLUMN     "max_joins" INTEGER NOT NULL DEFAULT 4;

ALTER TABLE "zeteo"."sources"
    ADD CONSTRAINT "sources_max_joins_check" CHECK ("max_joins" BETWEEN 1 AND 8);
