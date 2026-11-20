-- Loaded after sales.sql into the Azure SQL fixture, as probe.sql is into the
-- Postgres one:
--   probe.wide_rows  a view of 60,000 rows of 2 KB of text, made on the fly,
--                    far more than a byte cap, for reading a result in part;
--   probe.huge_rows  a view of 100 rows of 300,000 characters each, made on
--                    the fly, for sizing batches by the width of their rows;
--   probe.typed_values  3 rows of SQL Server's own types, for the wire forms;
--   probe.legacy_times  datetime values off the millisecond (1/300 s ticks)
--                       and smalldatetime minutes, to filter on as returned;
--   probe.legacy_text   text, ntext and xml, which SQL Server cannot sort;
--   probe.trickle    a view of 100 rows of 8,000 characters, the first at once
--                    and each later one 200 ms after the one before.
--   probe.zoned_events  instants either side of local midnight in Los
--                    Angeles, as Postgres's: `at` a datetimeoffset written at
--                    the instant's offset there, `naive` its UTC datetime2.
-- zeteo_ro reads it as a member of db_datareader.

CREATE SCHEMA probe;
GO

CREATE VIEW probe.wide_rows AS
  SELECT g.n AS id, CAST(REPLICATE('x', 2048) AS varchar(2048)) AS filler
    FROM (
      SELECT a.d + 10 * b.d + 100 * c.d + 1000 * e.d + 10000 * f.d + 1 AS n
        FROM (VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)) a (d)
       CROSS JOIN (VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)) b (d)
       CROSS JOIN (VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)) c (d)
       CROSS JOIN (VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)) e (d)
       CROSS JOIN (VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)) f (d)
    ) g
   WHERE g.n <= 60000;
GO

CREATE VIEW probe.huge_rows AS
  SELECT g.n AS id, REPLICATE(CAST('y' AS varchar(max)), 300000) AS filler
    FROM (
      SELECT a.d + 10 * b.d + 1 AS n
        FROM (VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)) a (d)
       CROSS JOIN (VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)) b (d)
    ) g;
GO

CREATE TABLE probe.typed_values (
  id int NOT NULL PRIMARY KEY,
  tiny tinyint,
  small smallint,
  regular int,
  big bigint,
  narrow_float real,
  wide_float float,
  exact decimal(38,9),
  short_exact numeric(5,2),
  cash money,
  small_cash smallmoney,
  flag bit,
  day date,
  legacy datetime,
  naive datetime2(7),
  minute smalldatetime,
  aware datetimeoffset(7),
  label nvarchar(50),
  code char(3),
  guid uniqueidentifier
);
GO

INSERT INTO probe.typed_values VALUES
  (1, 255, -32768, 2147483647, 9223372036854775807, 0.1, 0.30000000000000004,
   12345678901234567890.123456789, 1.10, 922337203685477.5807, 1.5, 1,
   '2026-03-31', '2026-03-31T23:59:59.997', '2026-03-31T23:59:59.9999999',
   '2026-03-31T23:59:00', '2026-03-31T23:59:59.9876543+02:00', N'zß😀', 'abc',
   '6F1C1B2E-3C4D-4E5F-8A9B-0C1D2E3F4A5B'),
  (2, 0, 7, -2147483648, -9223372036854775808, -3.25, 1e300,
   -0.000000001, -999.99, -922337203685477.5808, -214748.3648, 0,
   '0001-01-01', '1753-01-01T00:00:00', '0001-01-01T00:00:00',
   '1900-01-01T00:00:00', '2000-01-01T00:00:00-05:00', N'', 'x', NULL),
  (3, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL, NULL, NULL);
GO

CREATE TABLE probe.legacy_times (
  id int NOT NULL PRIMARY KEY,
  legacy datetime,
  minute smalldatetime
);
GO

INSERT INTO probe.legacy_times VALUES
  (1, '2026-01-01T00:00:00.000', '2026-01-01T00:00:00'),
  (2, '2026-01-01T00:00:00.003', '2026-01-01T00:01:00'),
  (3, '2026-01-01T00:00:00.007', '2026-01-01T00:02:00'),
  (4, '2026-01-01T00:00:00.010', '2026-01-01T00:03:00');
GO

CREATE TABLE probe.legacy_text (
  id int NOT NULL PRIMARY KEY,
  memo text,
  wide_memo ntext,
  doc xml
);
GO

INSERT INTO probe.legacy_text VALUES
  (1, 'Alpha memo', N'Wide ALPHA', N'<a>one</a>'),
  (2, 'beta memo', N'wide beta', N'<b>two</b>'),
  (3, NULL, NULL, NULL);
GO

-- A function can spin on the clock where a view cannot wait; INLINE = OFF
-- keeps it a call per row, made as each row is produced.
CREATE FUNCTION probe.trickle_pad (@n int)
RETURNS varchar(8000)
WITH INLINE = OFF
AS
BEGIN
  IF @n > 1
  BEGIN
    DECLARE @until datetime2 = DATEADD(millisecond, 200, SYSDATETIME());
    WHILE SYSDATETIME() < @until SET @n = @n;
  END
  RETURN REPLICATE(CAST('t' AS varchar(8000)), 8000);
END
GO

CREATE VIEW probe.trickle AS
  SELECT g.n AS id, probe.trickle_pad(g.n) AS filler
    FROM (
      SELECT a.d + 10 * b.d + 1 AS n
        FROM (VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)) a (d)
       CROSS JOIN (VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)) b (d)
    ) g;
GO

CREATE TABLE probe.zoned_events (
  id int NOT NULL PRIMARY KEY,
  at datetimeoffset(3) NOT NULL,
  naive datetime2(3) NOT NULL,
  day date NOT NULL,
  amount decimal(10,2) NOT NULL
);
GO

INSERT INTO probe.zoned_events VALUES
  (1,  '2026-07-12T20:00:00-07:00', '2026-07-13T03:00:00', '2026-07-12', 10.00),
  (2,  '2026-07-12T23:59:59-07:00', '2026-07-13T06:59:59', '2026-07-12', 20.00),
  (3,  '2026-07-13T00:00:00-07:00', '2026-07-13T07:00:00', '2026-07-13', 40.00),
  (4,  '2026-07-10T05:00:00-07:00', '2026-07-10T12:00:00', '2026-07-10', 80.00),
  (5,  '2026-07-31T22:00:00-07:00', '2026-08-01T05:00:00', '2026-07-31', 1.00),
  (6,  '2026-03-09T00:30:00-07:00', '2026-03-09T07:30:00', '2026-03-09', 2.00),
  (7,  '2026-03-07T23:30:00-08:00', '2026-03-08T07:30:00', '2026-03-07', 4.00),
  (8,  '2026-11-01T23:30:00-08:00', '2026-11-02T07:30:00', '2026-11-01', 8.00),
  (9,  '2026-03-31T20:00:00-07:00', '2026-04-01T03:00:00', '2026-03-31', 16.00),
  (10, '2025-12-31T23:59:59-08:00', '2026-01-01T07:59:59', '2025-12-31', 32.00);
GO
