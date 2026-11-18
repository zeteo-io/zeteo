-- File Sources' staging tables: raw text of an upload awaiting its load.
-- Outside Prisma's schemas, so Prisma neither models nor diffs it; Zeteo
-- creates and drops its tables with raw SQL. Nothing is granted on it: only
-- Zeteo's own login reads it, never the File Sources reader role.
CREATE SCHEMA IF NOT EXISTS "zeteo_file_staging";
