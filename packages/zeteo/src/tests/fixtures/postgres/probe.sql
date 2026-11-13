-- Loaded after sales.sql into the shared fixture database only (throwaway
-- copies of sales.sql skip it, as it takes a moment to fill):
--   probe.wide_rows  60000 rows of 2 KB of text, far more than a byte cap, for
--                    reading a result in batches.

CREATE SCHEMA probe;

CREATE TABLE probe.wide_rows (
  id integer PRIMARY KEY,
  filler text NOT NULL
);
INSERT INTO probe.wide_rows
  SELECT g, repeat('x', 2048) FROM generate_series(1, 60000) g;

GRANT USAGE ON SCHEMA probe TO zeteo_ro;
GRANT SELECT ON probe.wide_rows TO zeteo_ro;
