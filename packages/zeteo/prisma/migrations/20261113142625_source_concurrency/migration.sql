-- AlterTable
ALTER TABLE "zeteo"."sources" ADD COLUMN     "export_concurrency" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "query_concurrency" INTEGER NOT NULL DEFAULT 5;

-- CHECK constraints: Prisma cannot express them.
ALTER TABLE "zeteo"."sources"
    ADD CONSTRAINT "sources_query_concurrency_check" CHECK ("query_concurrency" BETWEEN 1 AND 50),
    ADD CONSTRAINT "sources_export_concurrency_check" CHECK ("export_concurrency" BETWEEN 1 AND 10);
