-- CreateTable
CREATE TABLE "zeteo"."calendar" (
    "id" INTEGER NOT NULL,
    "working_days" INTEGER[],
    "fiscal_year_start_month" INTEGER NOT NULL,
    "time_zone" TEXT NOT NULL,
    "updated_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calendar_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zeteo"."calendar_holidays" (
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "calendar_holidays_pkey" PRIMARY KEY ("date")
);

-- One row only; a month is 1..12.
ALTER TABLE "zeteo"."calendar" ADD CONSTRAINT "calendar_single_row" CHECK ("id" = 1);
ALTER TABLE "zeteo"."calendar" ADD CONSTRAINT "calendar_fiscal_year_start_month_range" CHECK ("fiscal_year_start_month" BETWEEN 1 AND 12);
