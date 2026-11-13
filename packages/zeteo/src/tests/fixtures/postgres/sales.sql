-- The source fixture. Tables and rows:
--   sales.accounts       2   (portable; queries)
--   sales.customers      3   (portable; queries; account_id -> accounts)
--   sales.orders        12   (portable; queries; two quarters of 2026)
--   sales.order_lines    0
--   sales.blobs          0   (types no query can use)
--   sales.typed_values   5   (Postgres-only types, for the wire forms)
--   sales.ledger         4   (portable; queries; uuid and money)
--   sales.moods          3   (Postgres-only: an enum, domains over an enum,
--                             money and uuid, and citext, char(n) and name)
--   hr.salaries          0   (not granted)
-- probe.sql adds a large table in schema `probe`, in the shared fixture only.
-- Views:
--   sales.paid_orders    the paid orders
--   sales.slow_orders    sleeps 3 s each time it is selected from
--   sales.session_flags  one row: the transaction's read-only flag
--   sales.broken_orders  divides by zero when its `ratio` is selected
-- The portable tables are mirrored row for row by the Azure SQL fixture; keep
-- their types and values expressible there, and their values deterministic.
-- Views reference only orders' id and total: catalogue tests change its other
-- columns in throwaway copies.

CREATE EXTENSION IF NOT EXISTS citext;

CREATE SCHEMA sales;
CREATE SCHEMA hr;

CREATE TABLE sales.accounts (
  id integer PRIMARY KEY,
  name text NOT NULL,
  plan text NOT NULL
);

CREATE TABLE sales.customers (
  id integer PRIMARY KEY,
  name text NOT NULL,
  region text,
  email text,
  account_id integer REFERENCES sales.accounts (id)
);

CREATE TABLE sales.orders (
  id integer PRIMARY KEY,
  customer_id integer NOT NULL REFERENCES sales.customers (id),
  status text NOT NULL,
  total numeric(12,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  notes text,
  external_ref bigint
);

CREATE TABLE sales.order_lines (
  order_id integer NOT NULL REFERENCES sales.orders (id),
  line_no integer NOT NULL,
  sku text NOT NULL,
  qty integer NOT NULL,
  price numeric NOT NULL,
  PRIMARY KEY (order_id, line_no)
);

CREATE VIEW sales.paid_orders AS
  SELECT id, customer_id, total FROM sales.orders WHERE status = 'paid';

CREATE VIEW sales.slow_orders AS
  SELECT o.id, o.total FROM sales.orders o CROSS JOIN pg_sleep(3);

CREATE VIEW sales.session_flags AS
  SELECT current_setting('transaction_read_only') AS read_only;

CREATE VIEW sales.broken_orders AS
  SELECT id, total / (id - id) AS ratio FROM sales.orders;

CREATE TABLE sales.blobs (
  id integer,
  data bytea,
  tags text[]
);

CREATE TABLE sales.typed_values (
  id integer PRIMARY KEY,
  small smallint,
  big bigint,
  single real,
  double double precision,
  exact numeric,
  flag boolean,
  day date,
  naive timestamp,
  aware timestamptz,
  doc json,
  docb jsonb,
  code uuid
);

CREATE TABLE sales.ledger (
  id integer PRIMARY KEY,
  ref uuid,
  amount money
);

-- Declared in an order that is not alphabetical, so sorting as text shows.
CREATE TYPE sales.mood AS ENUM ('sad', 'ok', 'happy');
CREATE DOMAIN sales.feeling AS sales.mood;
CREATE DOMAIN sales.price AS money;
CREATE DOMAIN sales.token AS uuid;

CREATE TABLE sales.moods (
  id integer PRIMARY KEY,
  mood sales.mood,
  feeling sales.feeling,
  price sales.price,
  token sales.token,
  label citext,
  code char(4),
  handle name
);

CREATE TABLE hr.salaries (
  employee text,
  amount numeric
);

INSERT INTO sales.accounts VALUES
  (1, 'Northwind', 'enterprise'),
  (2, 'Contoso', 'starter');

INSERT INTO sales.customers VALUES
  (1, 'Acme', 'EU', 'a@example.com', 1),
  (2, '100% Organic_Foods', 'US', NULL, 1),
  (3, 'MiXeD Case Ltd', 'EU', 'm@example.com', 2);

INSERT INTO sales.orders VALUES
  (1, 1, 'paid', 10.00, '2026-01-05 09:00:00+00', NULL, NULL),
  (2, 1, 'paid', 250.50, '2026-01-20 14:30:00+00', 'rush', 9007199254740993),
  (3, 2, 'shipped', 99.99, '2026-02-02 08:15:00+00', NULL, 1),
  (4, 3, 'paid', 1200.00, '2026-02-14 18:45:30+00', 'gift wrap', NULL),
  (5, 2, 'cancelled', 5.25, '2026-03-01 00:00:00+00', NULL, -42),
  (6, 3, 'paid', 75.00, '2026-03-31 23:59:59.999+00', 'end of quarter', 123456789012),
  (7, 1, 'shipped', 18.40, '2026-04-01 00:00:00+00', NULL, NULL),
  (8, 2, 'paid', 640.10, '2026-04-18 11:11:11+00', 'Call First', 7),
  (9, 3, 'pending', 33.33, '2026-05-05 05:05:05+00', NULL, NULL),
  (10, 1, 'paid', 410.00, '2026-05-25 16:00:00+00', 'repeat', 8),
  (11, 2, 'shipped', 12.00, '2026-06-10 10:10:10.5+00', NULL, 9),
  (12, 3, 'paid', 999.99, '2026-06-30 12:00:00+00', 'big', 10);

INSERT INTO sales.typed_values VALUES
  (1, 7, 9223372036854775807, 1.5, 0.30000000000000004,
   12345678901234567890.123456789, true, '2026-03-31',
   '2026-03-31 23:59:59.123456', '2026-03-31 23:59:59.987654+02',
   '{"a": [1, 2]}', '{"b": null}', '6f1c1b2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b'),
  (2, -32768, -9223372036854775808, 'NaN', 'Infinity', 'NaN', false,
   'infinity', '-infinity', 'infinity', '[]', '"text"', NULL),
  (3, 0, 0, '-Infinity', '-Infinity', 0, NULL, '0044-03-15 BC',
   '0099-01-01 00:00:00', '1999-12-31 23:00:00-05', 'null', '1.50', NULL),
  (4, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  (5, 1, 1, 3.25, 1e300, 1.10, true, '2026-01-01',
   '2026-01-01 00:00:00', '2026-01-01 00:00:00.000999+00',
   '{"z": 1, "a": 2}', '{"z": 1, "a": 2}', NULL);

INSERT INTO sales.ledger VALUES
  (1, '6f1c1b2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b', 1234.50),
  (2, 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 0.99),
  (3, '00000000-0000-0000-0000-000000000003', -12.25),
  (4, NULL, NULL);

INSERT INTO sales.moods VALUES
  (1, 'happy', 'sad', 10.50, '6f1c1b2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b', 'Beta', 'ab', 'zed'),
  (2, 'sad', 'happy', 2.25, NULL, 'alpha', 'cd', 'Amy'),
  (3, 'ok', NULL, NULL, 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', NULL, NULL, 'bo');

GRANT USAGE ON SCHEMA sales TO zeteo_ro, zeteo_rw, zeteo_owner;
GRANT SELECT ON ALL TABLES IN SCHEMA sales TO zeteo_ro, zeteo_rw, zeteo_owner;
GRANT INSERT ON sales.orders TO zeteo_rw;
ALTER TABLE sales.customers OWNER TO zeteo_owner;
