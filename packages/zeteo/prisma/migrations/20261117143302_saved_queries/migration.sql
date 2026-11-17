-- AlterTable
ALTER TABLE "zeteo"."query_runs" ADD COLUMN     "saved_query_id" UUID;

-- CreateTable
CREATE TABLE "zeteo"."saved_queries" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "query" JSONB NOT NULL,
    "last_run_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "saved_queries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zeteo"."saved_query_shares" (
    "saved_query_id" UUID NOT NULL,
    "principal_type" "zeteo"."principal_type" NOT NULL,
    "principal_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_query_shares_pkey" PRIMARY KEY ("saved_query_id","principal_type","principal_id")
);

-- CreateTable
CREATE TABLE "zeteo"."saved_query_user_runs" (
    "saved_query_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "last_run_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "saved_query_user_runs_pkey" PRIMARY KEY ("saved_query_id","user_id")
);

-- CreateIndex
CREATE INDEX "saved_queries_owner_id_idx" ON "zeteo"."saved_queries"("owner_id");

-- CreateIndex
CREATE INDEX "saved_queries_source_id_idx" ON "zeteo"."saved_queries"("source_id");

-- CreateIndex
CREATE INDEX "saved_query_shares_principal_type_principal_id_idx" ON "zeteo"."saved_query_shares"("principal_type", "principal_id");

-- CreateIndex
CREATE INDEX "query_runs_saved_query_id_idx" ON "zeteo"."query_runs"("saved_query_id");

-- AddForeignKey
ALTER TABLE "zeteo"."query_runs" ADD CONSTRAINT "query_runs_saved_query_id_fkey" FOREIGN KEY ("saved_query_id") REFERENCES "zeteo"."saved_queries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zeteo"."saved_queries" ADD CONSTRAINT "saved_queries_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "zeteo"."sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zeteo"."saved_query_shares" ADD CONSTRAINT "saved_query_shares_saved_query_id_fkey" FOREIGN KEY ("saved_query_id") REFERENCES "zeteo"."saved_queries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zeteo"."saved_query_user_runs" ADD CONSTRAINT "saved_query_user_runs_saved_query_id_fkey" FOREIGN KEY ("saved_query_id") REFERENCES "zeteo"."saved_queries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A name is unique per owner whatever its case; Prisma cannot express an expression index.
CREATE UNIQUE INDEX saved_queries_owner_name_key ON "zeteo"."saved_queries" (owner_id, lower(name));
