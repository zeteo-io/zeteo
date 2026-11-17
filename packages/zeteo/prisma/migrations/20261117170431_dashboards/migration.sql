-- CreateEnum
CREATE TYPE "zeteo"."dashboard_theme" AS ENUM ('light', 'dark', 'auto');

-- CreateEnum
CREATE TYPE "zeteo"."panel_kind" AS ENUM ('own', 'linked');

-- AlterEnum
ALTER TYPE "zeteo"."entry_point" ADD VALUE 'dashboard';

-- AlterTable
ALTER TABLE "zeteo"."query_runs" ADD COLUMN     "dashboard_id" UUID;

-- AlterTable
ALTER TABLE "zeteo"."saved_queries" ADD COLUMN     "available_for_dashboards" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "available_organization_id" UUID;

-- CreateTable
CREATE TABLE "zeteo"."dashboards" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "time_range" TEXT,
    "refresh_seconds" INTEGER,
    "theme" "zeteo"."dashboard_theme" NOT NULL DEFAULT 'auto',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dashboards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zeteo"."dashboard_panels" (
    "id" UUID NOT NULL,
    "dashboard_id" UUID NOT NULL,
    "kind" "zeteo"."panel_kind" NOT NULL,
    "x" INTEGER NOT NULL,
    "y" INTEGER NOT NULL,
    "w" INTEGER NOT NULL,
    "h" INTEGER NOT NULL,
    "title" TEXT,
    "saved_query_id" UUID,
    "saved_panel_id" UUID,
    "chart" JSONB,
    "time_column" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dashboard_panels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zeteo"."dashboard_shares" (
    "dashboard_id" UUID NOT NULL,
    "principal_type" "zeteo"."principal_type" NOT NULL,
    "principal_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dashboard_shares_pkey" PRIMARY KEY ("dashboard_id","principal_type","principal_id")
);

-- CreateTable
CREATE TABLE "zeteo"."saved_panels" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "saved_query_id" UUID,
    "chart" JSONB NOT NULL,
    "time_column" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "saved_panels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zeteo"."saved_panel_shares" (
    "saved_panel_id" UUID NOT NULL,
    "principal_type" "zeteo"."principal_type" NOT NULL,
    "principal_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_panel_shares_pkey" PRIMARY KEY ("saved_panel_id","principal_type","principal_id")
);

-- CreateIndex
CREATE INDEX "dashboards_owner_id_idx" ON "zeteo"."dashboards"("owner_id");

-- CreateIndex
CREATE INDEX "dashboard_panels_dashboard_id_idx" ON "zeteo"."dashboard_panels"("dashboard_id");

-- CreateIndex
CREATE INDEX "dashboard_panels_saved_query_id_idx" ON "zeteo"."dashboard_panels"("saved_query_id");

-- CreateIndex
CREATE INDEX "dashboard_panels_saved_panel_id_idx" ON "zeteo"."dashboard_panels"("saved_panel_id");

-- CreateIndex
CREATE INDEX "dashboard_shares_principal_type_principal_id_idx" ON "zeteo"."dashboard_shares"("principal_type", "principal_id");

-- CreateIndex
CREATE INDEX "saved_panels_owner_id_idx" ON "zeteo"."saved_panels"("owner_id");

-- CreateIndex
CREATE INDEX "saved_panels_saved_query_id_idx" ON "zeteo"."saved_panels"("saved_query_id");

-- CreateIndex
CREATE INDEX "saved_panel_shares_principal_type_principal_id_idx" ON "zeteo"."saved_panel_shares"("principal_type", "principal_id");

-- CreateIndex
CREATE INDEX "query_runs_dashboard_id_idx" ON "zeteo"."query_runs"("dashboard_id");

-- CreateIndex
CREATE INDEX "saved_queries_available_for_dashboards_available_organizati_idx" ON "zeteo"."saved_queries"("available_for_dashboards", "available_organization_id");

-- AddForeignKey
ALTER TABLE "zeteo"."query_runs" ADD CONSTRAINT "query_runs_dashboard_id_fkey" FOREIGN KEY ("dashboard_id") REFERENCES "zeteo"."dashboards"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zeteo"."dashboard_panels" ADD CONSTRAINT "dashboard_panels_dashboard_id_fkey" FOREIGN KEY ("dashboard_id") REFERENCES "zeteo"."dashboards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zeteo"."dashboard_panels" ADD CONSTRAINT "dashboard_panels_saved_query_id_fkey" FOREIGN KEY ("saved_query_id") REFERENCES "zeteo"."saved_queries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zeteo"."dashboard_panels" ADD CONSTRAINT "dashboard_panels_saved_panel_id_fkey" FOREIGN KEY ("saved_panel_id") REFERENCES "zeteo"."saved_panels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zeteo"."dashboard_shares" ADD CONSTRAINT "dashboard_shares_dashboard_id_fkey" FOREIGN KEY ("dashboard_id") REFERENCES "zeteo"."dashboards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zeteo"."saved_panels" ADD CONSTRAINT "saved_panels_saved_query_id_fkey" FOREIGN KEY ("saved_query_id") REFERENCES "zeteo"."saved_queries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zeteo"."saved_panel_shares" ADD CONSTRAINT "saved_panel_shares_saved_panel_id_fkey" FOREIGN KEY ("saved_panel_id") REFERENCES "zeteo"."saved_panels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A name is unique per owner whatever its case; Prisma cannot express an expression index.
CREATE UNIQUE INDEX dashboards_owner_name_key ON "zeteo"."dashboards" (owner_id, lower(name));
CREATE UNIQUE INDEX saved_panels_owner_name_key ON "zeteo"."saved_panels" (owner_id, lower(name));

-- An own panel has no saved panel; a linked one carries neither a saved query, a chart nor a time column of its own.
ALTER TABLE "zeteo"."dashboard_panels" ADD CONSTRAINT dashboard_panels_kind_check CHECK (
  (kind = 'own' AND saved_panel_id IS NULL)
  OR (kind = 'linked' AND saved_query_id IS NULL AND chart IS NULL AND time_column IS NULL)
);
-- A panel sits inside the 12-column grid.
ALTER TABLE "zeteo"."dashboard_panels" ADD CONSTRAINT dashboard_panels_grid_check CHECK (
  x >= 0 AND y >= 0 AND w BETWEEN 1 AND 12 AND h BETWEEN 1 AND 24 AND x + w <= 12
);
