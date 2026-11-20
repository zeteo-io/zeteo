-- CreateEnum
CREATE TYPE "zeteo"."row_access" AS ENUM ('unlimited_default', 'all', 'rule');

-- AlterTable
ALTER TABLE "zeteo"."grants" DROP COLUMN "row_filter",
ADD COLUMN     "identity_key_ids" UUID[] DEFAULT ARRAY[]::UUID[],
ADD COLUMN     "row_access" "zeteo"."row_access" NOT NULL DEFAULT 'unlimited_default',
ADD COLUMN     "row_rule" JSONB,
ADD COLUMN     "row_rule_description" VARCHAR(200);

-- CreateTable
CREATE TABLE "zeteo"."identity_keys" (
    "id" UUID NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "label" VARCHAR(100) NOT NULL,
    "description" VARCHAR(500),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "identity_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zeteo"."identity_values" (
    "id" UUID NOT NULL,
    "key_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "value" VARCHAR(500) NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_values_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "identity_keys_name_key" ON "zeteo"."identity_keys"("name");

-- CreateIndex
CREATE INDEX "identity_values_user_id_idx" ON "zeteo"."identity_values"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "identity_values_key_id_value_key" ON "zeteo"."identity_values"("key_id", "value");

-- AddForeignKey
ALTER TABLE "zeteo"."identity_values" ADD CONSTRAINT "identity_values_key_id_fkey" FOREIGN KEY ("key_id") REFERENCES "zeteo"."identity_keys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Constraints Prisma cannot express
-- Dropping "row_filter" above also dropped "grants_row_filter_reserved_check".

ALTER TABLE "zeteo"."grants"
    ADD CONSTRAINT "grants_row_rule_check" CHECK (("row_access" = 'rule') = ("row_rule" IS NOT NULL));

ALTER TABLE "zeteo"."grants"
    ADD CONSTRAINT "grants_row_rule_description_check" CHECK ("row_rule_description" IS NULL OR "row_access" = 'rule');

ALTER TABLE "zeteo"."identity_keys"
    ADD CONSTRAINT "identity_keys_name_check" CHECK ("name" ~ '^[a-z][a-z0-9_]{0,63}$');
