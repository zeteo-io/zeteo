// @module-tag int
// @module-tag platform
import { AzureSqlPreparedQuery } from "../../../adapters/azure-sql/runQuery.js";
import { AzureSqlConnection } from "../../../adapters/azure-sql/connect.js";
import { HIGH_WATER_ROWS } from "../../../adapters/azure-sql/runQuery.js";
import type { SourceConnection } from "../../../adapters/types.js";
import { AppError } from "../../../utils/errors.js";
import { describe, expect, it, vi } from "vitest";
import sql from "mssql";
import {
  OPTIONS,
  drain,
  limitsOf,
  noneWithin,
  runningOn,
  useMssqlRuns,
} from "../../support/mssqlRuns.js";

const {
  connection,
  connectWith,
  connectWithDriverOptions,
  counting,
  open,
  plan,
  run,
} = useMssqlRuns();

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

  it("cuts a timestamp's fraction at SQL Server's seven digits instead of rounding into the next day", async () => {
    const result = await run({
      from: "typed_values",
      select: ["id"],
      where: { naive: { eq: "2026-03-31T23:59:59.99999999Z" } },
    });
    expect(result.rows).toEqual([[1]]);
  });

  it("finds a datetime row again by the value it returned, off the millisecond", async () => {
    const { rows } = await run({
      from: "legacy_times",
      select: ["id", "legacy"],
      orderBy: [{ id: "asc" }],
    });
    expect(rows).toEqual([
      [1, "2026-01-01T00:00:00.000Z"],
      [2, "2026-01-01T00:00:00.003Z"],
      [3, "2026-01-01T00:00:00.007Z"],
      [4, "2026-01-01T00:00:00.010Z"],
    ]);
    for (const [id, legacy] of rows) {
      const found = await run({
        from: "legacy_times",
        select: ["id"],
        where: { legacy: { eq: legacy } },
      });
      expect(found.rows).toEqual([[id]]);
    }
    const ids = async (where: object) =>
      (await run({ from: "legacy_times", select: ["id"], where })).rows;
    expect(await ids({ legacy: { lte: "2026-01-01T00:00:00.007Z" } })).toEqual([
      [1],
      [2],
      [3],
    ]);
    expect(await ids({ legacy: { gt: "2026-01-01T00:00:00.003Z" } })).toEqual([
      [3],
      [4],
    ]);
  });

  it("finds a smalldatetime row again by the value it returned, and compares between minutes exactly", async () => {
    const { rows } = await run({
      from: "legacy_times",
      select: ["id", "minute"],
      orderBy: [{ id: "asc" }],
    });
    expect(rows.map((r) => r[1])).toEqual([
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:01:00.000Z",
      "2026-01-01T00:02:00.000Z",
      "2026-01-01T00:03:00.000Z",
    ]);
    for (const [id, minute] of rows) {
      const found = await run({
        from: "legacy_times",
        select: ["id"],
        where: { minute: { eq: minute } },
      });
      expect(found.rows).toEqual([[id]]);
    }
    const found = await run({
      from: "legacy_times",
      select: ["id"],
      where: {
        minute: {
          between: ["2026-01-01T00:00:30Z", "2026-01-01T00:02:29.999Z"],
        },
      },
    });
    expect(found.rows).toEqual([[2], [3]]);
  });

  it("reads text, ntext and xml as text: selected, matched, sorted and deduplicated", async () => {
    expect(
      (await run({ from: "legacy_text", select: ["memo", "wide_memo", "doc"] }))
        .rows
    ).toEqual([
      ["Alpha memo", "Wide ALPHA", "<a>one</a>"],
      ["beta memo", "wide beta", "<b>two</b>"],
      [null, null, null],
    ]);
    const ids = async (query: object) =>
      (await run({ from: "legacy_text", select: ["id"], ...query })).rows;
    expect(await ids({ where: { memo: { contains: "ALPHA" } } })).toEqual([
      [1],
    ]);
    expect(
      await ids({ where: { wide_memo: { startsWith: "wide a" } } })
    ).toEqual([[1]]);
    expect(await ids({ where: { doc: { contains: "two" } } })).toEqual([[2]]);
    expect(await ids({ orderBy: [{ wide_memo: "desc" }] })).toEqual([
      [3],
      [2],
      [1],
    ]);
    expect(
      (await run({ from: "legacy_text", select: ["doc"], distinct: true })).rows
    ).toEqual([["<a>one</a>"], ["<b>two</b>"], [null]]);
  });

  it("sums a real column as a real, printed short", async () => {
    const result = await run({
      from: "typed_values",
      select: [{ sum: "narrow_float" }, { sum: "wide_float" }],
    });
    expect(result.rows).toEqual([[-3.15, 1e300]]);
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

const ACCOUNTS = [[1], [2]];

const inUse = (conn: SourceConnection) =>
  (conn as AzureSqlConnection).pool.borrowed;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** How many rows the driver has parsed, of every request, from now on. */
const rowsParsed = () => {
  const emit = vi.spyOn(sql.Request.prototype, "emit");
  return () => emit.mock.calls.filter(([event]) => event === "row").length;
};

// The most rows of `counting` a 4 KB packet, tedious's default, holds a part
// of: each is over 2 KB.
const PACKET_ROWS = 3;

describe("azure-sql openQuery: the row stream", () => {
  it("knows its columns once open and returns [] after the end, however often asked", async () => {
    const single = await connectWith({ ...OPTIONS, poolSize: 1 });
    const stream = await open({ from: "orders", select: ["id"] }, 5000, single);
    expect(stream.columns).toEqual([{ name: "id", type: "number" }]);
    expect(await drain(stream)).toEqual(
      Array.from({ length: 12 }, (_, i) => [i + 1])
    );
    expect(await stream.next(5)).toEqual([]);
    expect(await stream.next(5)).toEqual([]);
    await stream.close();
    expect(inUse(single)).toBe(0);
  });

  it.each([0, -1, 2.5])("refuses to read %s rows", async (size) => {
    const stream = await open({ from: "orders", select: ["id"] });
    try {
      await expect(stream.next(size)).rejects.toThrow("invalid batch size");
      expect(await stream.next(3)).toEqual([[1], [2], [3]]);
    } finally {
      await stream.close();
    }
  });

  it("stops the statement on the server when closed mid-result, and the pool gives the connection out again", async () => {
    const single = await connectWith({ ...OPTIONS, poolSize: 1 });
    // Far more than the network between the server and the driver buffers.
    const stream = await open(
      { from: "wide_rows", select: ["id", "filler"], orderBy: [{ id: "asc" }] },
      10_000,
      single
    );
    const ids: unknown[] = [];
    while (ids.length < 10) {
      ids.push(...(await stream.next(10 - ids.length)).map(([id]) => id));
    }
    expect(ids).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
    expect(await runningOn("wide_rows")).toHaveLength(1);
    await stream.close();
    expect(await noneWithin("wide_rows", 2000)).toBe(true);
    expect(inUse(single)).toBe(0);
    await expect(stream.next(1)).rejects.toThrow("closed");
    const again = await open(
      { from: "accounts", select: ["id"] },
      5000,
      single
    );
    try {
      expect(await drain(again)).toEqual(ACCOUNTS);
    } finally {
      await again.close();
    }
  });

  it("closes harmlessly twice, and at once", async () => {
    const single = await connectWith({ ...OPTIONS, poolSize: 1 });
    const stream = await open(
      { from: "wide_rows", select: ["id"] },
      5000,
      single
    );
    await stream.next(1);
    await Promise.all([stream.close(), stream.close()]);
    await expect(stream.close()).resolves.toBeUndefined();
    expect(inUse(single)).toBe(0);
    const again = await open(
      { from: "accounts", select: ["id"] },
      5000,
      single
    );
    try {
      expect(await drain(again)).toEqual(ACCOUNTS);
    } finally {
      await again.close();
    }
  });

  it("holds the request back while nothing reads, and reads every row once something does", async () => {
    const parsed = rowsParsed();
    const stream = await connection().openQuery(
      counting(100_000),
      limitsOf(30_000)
    );
    try {
      // Nothing reads: the driver parses until the queue passes its high
      // water mark, finishes the packet it is in, and stops.
      let seen = -1;
      while (parsed() !== seen) {
        seen = parsed();
        await sleep(300);
      }
      expect(seen).toBeGreaterThan(HIGH_WATER_ROWS);
      expect(seen).toBeLessThanOrEqual(HIGH_WATER_ROWS + PACKET_ROWS);
      // The server waits on the connection with the rest of the result.
      expect(await runningOn("counting_rows")).toHaveLength(1);
      const rows = await drain(stream);
      expect(rows).toHaveLength(100_000);
      expect(rows[0]).toEqual(["1", "x".repeat(2048)]);
      expect(rows.at(-1)![0]).toBe("100000");
      expect(await stream.next(1)).toEqual([]);
    } finally {
      await stream.close();
    }
  });

  it("settles a read that is waiting when it is closed, stopping the statement", async () => {
    const single = await connectWith({ ...OPTIONS, poolSize: 1 });
    const quick = 300;
    // Its first rows come at once, each filling a packet; the rest wait 3 s
    // on the server, as slow_orders spins when it is first read from.
    const slowAfterFirst = new AzureSqlPreparedQuery(
      plan({ from: "wide_rows", select: ["id", "filler"] }),
      `SELECT TOP (${quick}) id AS c0, filler AS c1 /* slow_after_first */
         FROM probe.wide_rows
       UNION ALL SELECT id, 'x' FROM sales.slow_orders`,
      []
    );
    const stream = await single.openQuery(slowAfterFirst, limitsOf(10_000));
    // Reads until one waits: the server holds the last of the quick rows
    // back with the slow ones, in a packet it has not filled.
    let reading: Promise<{ rows: unknown[][] } | { err: unknown }>;
    let read = 0;
    for (;;) {
      reading = stream.next(quick).then(
        (rows) => ({ rows }),
        (err: unknown) => ({ err })
      );
      const settled = await Promise.race([reading, sleep(500)]);
      if (!settled) break;
      expect(settled).toHaveProperty("rows");
      read += (settled as { rows: unknown[][] }).rows.length;
    }
    expect(read).toBeGreaterThan(0);
    expect(read).toBeLessThan(quick);
    expect(await runningOn("slow_after_first")).toHaveLength(1);
    const begun = Date.now();
    await stream.close();
    expect(Date.now() - begun).toBeLessThan(2000);
    // The read neither hangs nor passes for the end of the result.
    const settled = await reading;
    expect(settled).toHaveProperty("err");
    expect((settled as { err: Error }).err).not.toBeInstanceOf(AppError);
    expect((settled as { err: Error }).err.message).toMatch(/closed/);
    expect(await runningOn("slow_after_first")).toEqual([]);
    expect(inUse(single)).toBe(0);
    const again = await open(
      { from: "accounts", select: ["id"] },
      5000,
      single
    );
    try {
      expect(await drain(again)).toEqual(ACCOUNTS);
    } finally {
      await again.close();
    }
  });
});
