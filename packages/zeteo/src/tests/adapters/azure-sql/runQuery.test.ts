// @module-tag int
// @module-tag platform
import { OPTIONS, runningOn, useMssqlRuns } from "../../support/mssqlRuns.js";
import { AzureSqlConnection } from "../../../adapters/azure-sql/connect.js";
import { describe, expect, it, vi } from "vitest";
import sql from "mssql";

const { connectWithDriverOptions, run } = useMssqlRuns();

const TYPED = {
  from: "typed_values",
  select: [
    "id",
    "tiny",
    "small",
    "regular",
    "big",
    "narrow_float",
    "wide_float",
    "exact",
    "short_exact",
    "cash",
    "small_cash",
    "flag",
    "day",
    "legacy",
    "naive",
    "minute",
    "aware",
    "label",
    "code",
    "guid",
  ],
  orderBy: [{ id: "asc" }],
};

const TYPED_ROWS = [
  [
    1,
    255,
    -32768,
    2147483647,
    "9223372036854775807",
    0.1,
    0.30000000000000004,
    "12345678901234567890.123456789",
    "1.10",
    "922337203685477.5807",
    "1.5000",
    true,
    "2026-03-31",
    "2026-03-31T23:59:59.997Z",
    // Cut at the millisecond, never rounded into the next day.
    "2026-03-31T23:59:59.999Z",
    "2026-03-31T23:59:00.000Z",
    "2026-03-31T21:59:59.987Z",
    "zß😀",
    "abc",
    "6F1C1B2E-3C4D-4E5F-8A9B-0C1D2E3F4A5B",
  ],
  [
    2,
    0,
    7,
    -2147483648,
    "-9223372036854775808",
    -3.25,
    1e300,
    "-0.000000001",
    "-999.99",
    "-922337203685477.5808",
    "-214748.3648",
    false,
    "0001-01-01",
    "1753-01-01T00:00:00.000Z",
    "0001-01-01T00:00:00.000Z",
    "1900-01-01T00:00:00.000Z",
    "2000-01-01T05:00:00.000Z",
    "",
    "x  ",
    null,
  ],
  [3, ...Array.from({ length: 19 }, () => null)],
];

describe("azure-sql runQuery", () => {
  it("returns every type in its wire form", async () => {
    const result = await run(TYPED);
    expect(result.truncated).toBe(false);
    expect(result.columns.map((c) => c.type)).toEqual([
      "number",
      "number",
      "number",
      "number",
      "number",
      "number",
      "number",
      "number",
      "number",
      "number",
      "number",
      "boolean",
      "date",
      "timestamp",
      "timestamp",
      "timestamp",
      "timestamp",
      "text",
      "text",
      "text",
    ]);
    expect(result.rows).toEqual(TYPED_ROWS);
  });

  it.each([
    [
      "a German session: day-first dates, weeks from Monday",
      { language: "Deutsch", datefirst: null, dateFormat: null },
      { datefirst: 1, format: "dmy" },
    ],
    [
      "a session with weeks from Wednesday and year-day-month dates",
      { datefirst: 3, dateFormat: "ydm", language: null },
      { datefirst: 3, format: "ydm" },
    ],
  ])(
    "gives the same wire forms, filters and buckets in %s",
    async (_, options, session) => {
      const hostile = (await connectWithDriverOptions(
        options as unknown as Partial<sql.config["options"]>,
        { ...OPTIONS, poolSize: 1 }
      )) as AzureSqlConnection;
      const { recordset } = await hostile.pool
        .request()
        .query(
          "SELECT @@DATEFIRST AS datefirst, date_format AS format FROM sys.dm_exec_sessions WHERE session_id = @@SPID"
        );
      expect(recordset).toEqual([session]);
      expect((await run(TYPED, {}, hostile)).rows).toEqual(TYPED_ROWS);
      expect(
        (
          await run(
            {
              from: "orders",
              select: [
                { bucket: "week", column: "created_at", as: "w" },
                { count: "*", as: "n" },
              ],
              where: {
                created_at: {
                  between: ["2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z"],
                },
              },
              groupBy: ["w"],
            },
            {},
            hostile
          )
        ).rows
      ).toEqual([
        ["2026-02-23T00:00:00.000Z", "1"],
        ["2026-03-30T00:00:00.000Z", "2"],
      ]);
      expect(
        (
          await run(
            {
              from: "typed_values",
              select: ["id"],
              where: {
                day: { eq: "2026-03-31" },
                legacy: { lt: "2026-04-01T00:00:00Z" },
              },
            },
            {},
            hostile
          )
        ).rows
      ).toEqual([[1]]);
    }
  );

  it("returns counts and sums as strings and averages as numbers", async () => {
    const result = await run({
      from: "orders",
      select: [
        { count: "*" },
        { countDistinct: "customer_id" },
        { sum: "total" },
        { avg: "total" },
        { max: "total" },
        { min: "created_at" },
      ],
    });
    expect(result.rows).toEqual([
      ["12", "3", "3754.56", 312.88, "1200.00", "2026-01-05T09:00:00.000Z"],
    ]);
  });

  it("joins, buckets in UTC and groups", async () => {
    const result = await run({
      from: "orders",
      join: ["customer"],
      select: [
        "customer.region",
        { bucket: "quarter", column: "created_at", as: "quarter" },
        { sum: "total", as: "revenue" },
        { count: "*", as: "orders" },
      ],
      groupBy: ["customer.region", "quarter"],
    });
    expect(result.rows).toEqual([
      ["EU", "2026-01-01T00:00:00.000Z", "1535.50", "4"],
      ["EU", "2026-04-01T00:00:00.000Z", "1461.72", "4"],
      ["US", "2026-01-01T00:00:00.000Z", "105.24", "2"],
      ["US", "2026-04-01T00:00:00.000Z", "652.10", "2"],
    ]);
  });

  it("groups a bucket with a filter, having and order: parameters only where they are not repeated", async () => {
    const result = await run({
      from: "orders",
      select: [
        { bucket: "month", column: "created_at", as: "month" },
        { sum: "total", as: "revenue" },
        { avg: "customer_id", as: "mean_customer" },
      ],
      where: {
        created_at: { gte: "2026-01-01T00:00:00Z" },
        total: { gt: "10.00" },
      },
      groupBy: ["month"],
      having: { revenue: { gt: 100 }, mean_customer: { gte: 1.5 } },
      orderBy: [{ revenue: "desc" }],
    });
    expect(result.rows).toEqual([
      ["2026-02-01T00:00:00.000Z", "1299.99", 2.5],
      ["2026-06-01T00:00:00.000Z", "1011.99", 2.5],
      ["2026-04-01T00:00:00.000Z", "658.50", 1.5],
      ["2026-05-01T00:00:00.000Z", "443.33", 2],
    ]);
  });

  it("follows a relation two joins deep", async () => {
    const result = await run({
      from: "orders",
      join: ["customer", "customer.account"],
      select: ["customer.account.plan", { count: "*" }],
      groupBy: ["customer.account.plan"],
    });
    expect(result.rows).toEqual([
      ["enterprise", "8"],
      ["starter", "4"],
    ]);
  });

  it.each([
    ["contains %", { name: { contains: "%" } }, [2]],
    ["contains _", { name: { contains: "_" } }, [2]],
    [
      "contains [, which is not a character class",
      { name: { contains: "[a-z]" } },
      [],
    ],
    ["startsWith, ignoring case", { name: { startsWith: "mixed" } }, [3]],
    ["isNull", { email: { isNull: true } }, [2]],
  ])("filters text with %s literally", async (_, where, ids) => {
    const result = await run({ from: "customers", select: ["id"], where });
    expect(result.rows).toEqual(ids.map((id) => [id]));
  });

  it("compares a 64-bit value without losing digits", async () => {
    const result = await run({
      from: "orders",
      select: ["id", "external_ref"],
      where: { external_ref: { eq: "9007199254740993" } },
    });
    expect(result.rows).toEqual([[2, "9007199254740993"]]);
  });

  it("compares timestamps as instants", async () => {
    const result = await run({
      from: "orders",
      select: ["id"],
      where: {
        created_at: {
          between: ["2026-03-31T20:29:59.999-03:30", "2026-04-01T00:00:00Z"],
        },
      },
    });
    expect(result.rows).toEqual([[6], [7]]);
  });

  it("compares a naive timestamp column as UTC", async () => {
    const result = await run({
      from: "typed_values",
      select: ["id"],
      where: { naive: { gte: "2026-04-01T01:59:59.999+02:00" } },
    });
    expect(result.rows).toEqual([[1]]);
  });

  describe("limits", () => {
    it("stops at maxRows and says so", async () => {
      const result = await run(
        { from: "orders", select: ["id"] },
        { maxRows: 5 }
      );
      expect(result.rows).toEqual([[1], [2], [3], [4], [5]]);
      expect(result.truncated).toBe("rows");
    });

    it("does not report truncation when the rows end at maxRows", async () => {
      const result = await run(
        { from: "orders", select: ["id"] },
        { maxRows: 12 }
      );
      expect(result.rows).toHaveLength(12);
      expect(result.truncated).toBe(false);
    });

    it("applies the plan's offset", async () => {
      const result = await run(
        { from: "orders", select: ["id"], offset: 10 },
        { maxRows: 5 }
      );
      expect(result.rows).toEqual([[11], [12]]);
      expect(result.truncated).toBe(false);
    });

    it("drops the row that would pass maxBytes and every row after it", async () => {
      const query = { from: "customers", select: ["id", "name"] };
      const sizes = (await run(query)).rows.map(
        (r) => Buffer.byteLength(JSON.stringify(r)) + 1
      );
      const cut = await run(query, { maxBytes: sizes[0] + sizes[1] - 1 });
      expect(cut.rows).toEqual([[1, "Acme"]]);
      expect(cut.truncated).toBe("bytes");
      const exact = await run(query, {
        maxBytes: sizes[0] + sizes[1] + sizes[2],
      });
      expect(exact.rows).toHaveLength(3);
      expect(exact.truncated).toBe(false);
    });
  });

  it("stops reading a result far past the byte cap, and stops it on the server", async () => {
    const emit = vi.spyOn(sql.Request.prototype, "emit");
    const begun = Date.now();
    const result = await run(
      { from: "wide_rows", select: ["id", "filler"], orderBy: [{ id: "asc" }] },
      { maxRows: 50_000, maxBytes: 100_000 }
    );
    expect(result.truncated).toBe("bytes");
    expect(result.rows.length).toBeGreaterThan(40);
    expect(result.rows.length).toBeLessThan(50);
    expect(result.rows[0]).toEqual([1, "x".repeat(2048)]);
    // Rows the driver parsed: those kept and what was in flight when the
    // cancel went out, not the 50,001 asked for.
    const parsed = emit.mock.calls.filter(([event]) => event === "row").length;
    expect(parsed).toBeLessThan(2000);
    expect(Date.now() - begun).toBeLessThan(1000);
    expect(await runningOn("wide_rows")).toEqual([]);
  });

  it("reads past a row cap far beyond one packet", async () => {
    const result = await run(
      { from: "wide_rows", select: ["id"], orderBy: [{ id: "asc" }] },
      { maxRows: 600 }
    );
    expect(result.rows).toHaveLength(600);
    expect(result.rows.at(-1)).toEqual([600]);
    expect(result.truncated).toBe("rows");
  });
});
