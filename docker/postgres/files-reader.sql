-- The File Sources reader role of the local and end-to-end stacks: a login
-- with no privileges of its own. Zeteo grants it USAGE on each zf_* schema and
-- SELECT on their tables, nothing else; it never reads the zeteo, core or
-- zeteo_file_staging schemas. Safe to run again. The password is a public
-- default for stacks published on 127.0.0.1 only; never reuse it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zeteo_files_reader') THEN
    CREATE ROLE zeteo_files_reader;
  END IF;
END
$$;
ALTER ROLE zeteo_files_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOBYPASSRLS PASSWORD 'zeteo-files-reader-local-only';
