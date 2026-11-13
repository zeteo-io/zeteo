-- CreateTable
CREATE TABLE "zeteo"."principal_limits" (
    "id" UUID NOT NULL,
    "principal_type" "zeteo"."principal_type" NOT NULL,
    "principal_id" UUID NOT NULL,
    "query_concurrency" INTEGER,
    "export_concurrency" INTEGER,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "principal_limits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "principal_limits_principal_type_principal_id_key" ON "zeteo"."principal_limits"("principal_type", "principal_id");

-- CHECK constraints: Prisma cannot express them.
ALTER TABLE "zeteo"."principal_limits"
    ADD CONSTRAINT "principal_limits_query_concurrency_check" CHECK ("query_concurrency" BETWEEN 1 AND 100),
    ADD CONSTRAINT "principal_limits_export_concurrency_check" CHECK ("export_concurrency" BETWEEN 1 AND 10),
    ADD CONSTRAINT "principal_limits_some_limit_check" CHECK ("query_concurrency" IS NOT NULL OR "export_concurrency" IS NOT NULL);
