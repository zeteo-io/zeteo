-- The Azure SQL fixture: the portable tables of fixtures/postgres/sales.sql,
-- with the same names, columns, keys and rows, so one query suite runs on both
-- engines. Tables and rows:
--   sales.accounts       2
--   sales.customers      3   (account_id -> accounts)
--   sales.orders        12   (two quarters of 2026)
--   sales.order_lines    0
--   hr.salaries          0   (denied to zeteo_ro)
-- Views:
--   sales.paid_orders    the paid orders
--   sales.slow_orders    spins 3 s each time it is selected from
--   sales.broken_orders  divides by zero when its `ratio` is selected
-- Not mirrored: sales.blobs, sales.typed_values (Postgres-only types) and
-- sales.session_flags (Postgres's transaction read-only flag).
--
-- The database keeps the server's default collation,
-- SQL_Latin1_General_CP1_CI_AS (case-insensitive), as an Azure SQL database
-- has unless created otherwise.
--
-- Loaded by support/mssqlFixture.ts, which splits batches on lines of `GO`.

CREATE SCHEMA sales;
GO
CREATE SCHEMA hr;
GO

CREATE TABLE sales.accounts (
  id int NOT NULL CONSTRAINT accounts_pkey PRIMARY KEY,
  name nvarchar(200) NOT NULL,
  [plan] nvarchar(200) NOT NULL
);

CREATE TABLE sales.customers (
  id int NOT NULL CONSTRAINT customers_pkey PRIMARY KEY,
  name nvarchar(200) NOT NULL,
  region nvarchar(200),
  email nvarchar(200),
  account_id int CONSTRAINT customers_account_id_fkey REFERENCES sales.accounts (id)
);

CREATE TABLE sales.orders (
  id int NOT NULL CONSTRAINT orders_pkey PRIMARY KEY,
  customer_id int NOT NULL CONSTRAINT orders_customer_id_fkey REFERENCES sales.customers (id),
  status nvarchar(200) NOT NULL,
  total decimal(12,2) NOT NULL,
  created_at datetimeoffset(6) NOT NULL DEFAULT SYSDATETIMEOFFSET(),
  notes nvarchar(200),
  external_ref bigint
);

CREATE TABLE sales.order_lines (
  order_id int NOT NULL CONSTRAINT order_lines_order_id_fkey REFERENCES sales.orders (id),
  line_no int NOT NULL,
  sku nvarchar(200) NOT NULL,
  qty int NOT NULL,
  price decimal(18,4) NOT NULL,
  CONSTRAINT order_lines_pkey PRIMARY KEY (order_id, line_no)
);

CREATE TABLE hr.salaries (
  employee nvarchar(200),
  amount decimal(18,2)
);
GO

-- A view cannot WAITFOR, and neither can a function; a function can spin on
-- the clock. Its argument is a constant, so the view's filter evaluates it
-- once per query, not per row, and only when the view is selected from.
-- INLINE = OFF keeps SQL Server from inlining it, and with it the loop.
CREATE FUNCTION sales.spin_seconds (@seconds int)
RETURNS int
WITH INLINE = OFF
AS
BEGIN
  DECLARE @until datetime2 = DATEADD(second, @seconds, SYSDATETIME());
  WHILE SYSDATETIME() < @until SET @seconds = @seconds;
  RETURN 0;
END
GO

CREATE VIEW sales.paid_orders AS
  SELECT id, customer_id, total FROM sales.orders WHERE status = 'paid';
GO

CREATE VIEW sales.slow_orders AS
  SELECT o.id, o.total FROM sales.orders o WHERE sales.spin_seconds(3) = 0;
GO

CREATE VIEW sales.broken_orders AS
  SELECT id, total / (id - id) AS ratio FROM sales.orders;
GO

INSERT INTO sales.accounts VALUES
  (1, N'Northwind', N'enterprise'),
  (2, N'Contoso', N'starter');

INSERT INTO sales.customers VALUES
  (1, N'Acme', N'EU', N'a@example.com', 1),
  (2, N'100% Organic_Foods', N'US', NULL, 1),
  (3, N'MiXeD Case Ltd', N'EU', N'm@example.com', 2);

INSERT INTO sales.orders VALUES
  (1, 1, N'paid', 10.00, '2026-01-05 09:00:00 +00:00', NULL, NULL),
  (2, 1, N'paid', 250.50, '2026-01-20 14:30:00 +00:00', N'rush', 9007199254740993),
  (3, 2, N'shipped', 99.99, '2026-02-02 08:15:00 +00:00', NULL, 1),
  (4, 3, N'paid', 1200.00, '2026-02-14 18:45:30 +00:00', N'gift wrap', NULL),
  (5, 2, N'cancelled', 5.25, '2026-03-01 00:00:00 +00:00', NULL, -42),
  (6, 3, N'paid', 75.00, '2026-03-31 23:59:59.999 +00:00', N'end of quarter', 123456789012),
  (7, 1, N'shipped', 18.40, '2026-04-01 00:00:00 +00:00', NULL, NULL),
  (8, 2, N'paid', 640.10, '2026-04-18 11:11:11 +00:00', N'Call First', 7),
  (9, 3, N'pending', 33.33, '2026-05-05 05:05:05 +00:00', NULL, NULL),
  (10, 1, N'paid', 410.00, '2026-05-25 16:00:00 +00:00', N'repeat', 8),
  (11, 2, N'shipped', 12.00, '2026-06-10 10:10:10.5 +00:00', NULL, 9),
  (12, 3, N'paid', 999.99, '2026-06-30 12:00:00 +00:00', N'big', 10);
GO

CREATE USER zeteo_ro FOR LOGIN zeteo_ro;
CREATE USER zeteo_rw FOR LOGIN zeteo_rw;
CREATE USER zeteo_owner FOR LOGIN zeteo_owner;
GO

-- zeteo_ro is the read-only login the docs describe: db_datareader, with one
-- schema denied.
ALTER ROLE db_datareader ADD MEMBER zeteo_ro;
DENY SELECT ON SCHEMA::hr TO zeteo_ro;
GRANT SELECT ON SCHEMA::sales TO zeteo_rw, zeteo_owner;
GRANT INSERT ON sales.orders TO zeteo_rw;
ALTER AUTHORIZATION ON OBJECT::sales.customers TO zeteo_owner;
