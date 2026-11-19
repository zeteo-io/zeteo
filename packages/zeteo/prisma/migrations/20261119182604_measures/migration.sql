-- CreateTable
CREATE TABLE "zeteo"."measures" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "table_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "formula" JSONB NOT NULL,
    "where" JSONB,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "measures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zeteo"."measure_editors" (
    "source_id" UUID NOT NULL,
    "principal_type" "zeteo"."principal_type" NOT NULL,
    "principal_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "measure_editors_pkey" PRIMARY KEY ("source_id","principal_type","principal_id")
);

-- CreateIndex
CREATE INDEX "measures_table_id_idx" ON "zeteo"."measures"("table_id");

-- CreateIndex
CREATE UNIQUE INDEX "measures_source_id_name_key" ON "zeteo"."measures"("source_id", "name");

-- AddForeignKey
ALTER TABLE "zeteo"."measures" ADD CONSTRAINT "measures_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "zeteo"."sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zeteo"."measures" ADD CONSTRAINT "measures_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "zeteo"."source_tables"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zeteo"."measure_editors" ADD CONSTRAINT "measure_editors_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "zeteo"."sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A measure's description is required and at most 2,000 characters.
ALTER TABLE "zeteo"."measures" ADD CONSTRAINT "measures_description_length" CHECK (char_length("description") BETWEEN 1 AND 2000);
