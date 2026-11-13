-- Loaded after sales.sql into the shared fixture database only:
--   probe.wide_rows  a view of 60,000 rows of 2 KB of text, made on the fly,
--                    far more than a byte cap, for reading a result in batches.
-- The text comes from a function costed high, so the planner computes it only
-- for rows that leave the sort on `id`: the sort holds integers, in memory.

CREATE SCHEMA probe;

CREATE FUNCTION probe.pad(n integer) RETURNS text
  LANGUAGE plpgsql IMMUTABLE COST 10000
  AS $$ BEGIN RETURN repeat('x', 2048); END $$;

CREATE VIEW probe.wide_rows AS
  SELECT g AS id, probe.pad(g) AS filler FROM generate_series(1, 60000) g;

GRANT USAGE ON SCHEMA probe TO zeteo_ro;
GRANT SELECT ON probe.wide_rows TO zeteo_ro;
