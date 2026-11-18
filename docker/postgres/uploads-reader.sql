-- The uploads reader role of the local and end-to-end stacks. Run as
-- Zeteo's own login on Zeteo's database; safe to run again. The password is a
-- public default for stacks published on 127.0.0.1 only; never reuse it.
--
-- What an operator runs for a deployment, as a role that may create roles,
-- on Zeteo's database (here `zeteo`), then sets UPLOADS_READER_URL to
-- this role on that database:
--
--   CREATE ROLE zeteo_uploads_reader LOGIN PASSWORD '<secret>'
--     NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
--   -- PUBLIC may create temporary tables by default; the reader must not.
--   REVOKE TEMP ON DATABASE zeteo FROM PUBLIC;
--   GRANT TEMP ON DATABASE zeteo TO <zeteo's own role>;
--
-- Grant the reader nothing else and make it a member of no role: Zeteo grants
-- it USAGE on each zu_* schema and SELECT on their tables, and it never reads
-- the zeteo, core or zeteo_upload_staging schemas. Zeteo refuses to start when
-- the role is on another database, is not the role in the URL, is a
-- superuser, bypasses row security, is a member of a role, can use those
-- schemas, or has TEMP or CREATE on the database. PUBLIC's CONNECT on other
-- databases of the server still lets it sign in to them; revoke CONNECT there
-- from PUBLIC if they hold anything PUBLIC can read.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zeteo_uploads_reader') THEN
    CREATE ROLE zeteo_uploads_reader;
  END IF;
  EXECUTE format('REVOKE TEMP ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT TEMP ON DATABASE %I TO CURRENT_USER', current_database());
END
$$;
ALTER ROLE zeteo_uploads_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOBYPASSRLS PASSWORD 'zeteo-uploads-reader-local-only';
