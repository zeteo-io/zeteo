-- Loaded after sales.sql into the shared fixture database only:
--   probe.wide_rows  a view of 60,000 rows of 2 KB of text, made on the fly,
--                    far more than a byte cap, for reading a result in batches.
--   probe.huge_rows  a view of 100 rows of 300,000 characters each, made on
--                    the fly, for sizing batches by the width of their rows.
--   probe.trickle    a view of 100 rows of 8,000 characters, the first at once
--                    and each later one 200 ms after the one before: a result
--                    still being read when a test acts on it.
--   probe.zoned_events  instants either side of local midnight in Los
--                    Angeles, of a month, a year and its DST changes, with
--                    each one's local date there, for buckets and date parts
--                    read in a calendar's zone. The same rows on both engines.
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

CREATE FUNCTION probe.huge_pad(n integer) RETURNS text
  LANGUAGE plpgsql IMMUTABLE COST 10000
  AS $$ BEGIN RETURN repeat('y', 300000); END $$;

CREATE VIEW probe.huge_rows AS
  SELECT g AS id, probe.huge_pad(g) AS filler FROM generate_series(1, 100) g;

GRANT SELECT ON probe.huge_rows TO zeteo_ro;

-- Not immutable, but declared so: a query sorts on `id`, and only a function
-- the planner may evaluate after the sort keeps the rows coming one by one.
CREATE FUNCTION probe.trickle_pad(n integer) RETURNS text
  LANGUAGE plpgsql IMMUTABLE COST 10000
  AS $$ BEGIN
    IF n > 1 THEN PERFORM pg_sleep(0.2); END IF;
    RETURN repeat('t', 8000);
  END $$;

CREATE VIEW probe.trickle AS
  SELECT g AS id, probe.trickle_pad(g) AS filler FROM generate_series(1, 100) g;

GRANT SELECT ON probe.trickle TO zeteo_ro;

CREATE TABLE probe.zoned_events (
  id integer PRIMARY KEY,
  at timestamptz NOT NULL,
  naive timestamp NOT NULL,
  day date NOT NULL,
  amount numeric(10,2) NOT NULL
);

INSERT INTO probe.zoned_events VALUES
  (1,  '2026-07-13T03:00:00Z', '2026-07-13T03:00:00', '2026-07-12', 10.00),
  (2,  '2026-07-13T06:59:59Z', '2026-07-13T06:59:59', '2026-07-12', 20.00),
  (3,  '2026-07-13T07:00:00Z', '2026-07-13T07:00:00', '2026-07-13', 40.00),
  (4,  '2026-07-10T12:00:00Z', '2026-07-10T12:00:00', '2026-07-10', 80.00),
  (5,  '2026-08-01T05:00:00Z', '2026-08-01T05:00:00', '2026-07-31', 1.00),
  (6,  '2026-03-09T07:30:00Z', '2026-03-09T07:30:00', '2026-03-09', 2.00),
  (7,  '2026-03-08T07:30:00Z', '2026-03-08T07:30:00', '2026-03-07', 4.00),
  (8,  '2026-11-02T07:30:00Z', '2026-11-02T07:30:00', '2026-11-01', 8.00),
  (9,  '2026-04-01T03:00:00Z', '2026-04-01T03:00:00', '2026-03-31', 16.00),
  (10, '2026-01-01T07:59:59Z', '2026-01-01T07:59:59', '2025-12-31', 32.00);

GRANT SELECT ON probe.zoned_events TO zeteo_ro;
