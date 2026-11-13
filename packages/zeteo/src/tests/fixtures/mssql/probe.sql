-- Loaded after sales.sql into the Azure SQL fixture, as probe.sql is into the
-- Postgres one:
--   probe.wide_rows  a view of 60,000 rows of 2 KB of text, made on the fly,
--                    far more than a byte cap, for reading a result in part;
--   probe.typed_values  3 rows of SQL Server's own types, for the wire forms.
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
