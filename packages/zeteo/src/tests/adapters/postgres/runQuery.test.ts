// @module-tag int
// @module-tag platform
import type { RunLimits, SourceConnection } from "../../../adapters/types.js";
import { PostgresConnection } from "../../../adapters/postgres/connect.js";
import { buildVisibleCatalog } from "../../../grants/visibleCatalog.js";
import type { VisibleCatalog } from "../../../grants/visibleCatalog.js";
import { postgresAdapter } from "../../../adapters/postgres/index.js";
import { initializeTereo, stopTereo } from "../../../utils/tereo.js";
import { toPgConfig } from "../../../adapters/postgres/settings.js";
import { sqlQuerySchema } from "../../../adapters/sql/language.js";
import { sealSettings } from "../../../utils/crypto/envelope.js";
import { closeAllSourcePools } from "../../../sources/pools.js";
import * as cancel from "../../../adapters/postgres/cancel.js";
import type { SqlPlan } from "../../../adapters/sql/types.js";
import { refreshSource } from "../../../catalog/refresh.js";
import { planSql } from "../../../adapters/sql/plan.js";
import { prisma } from "../../../utils/db/prisma.js";
import { db } from "../../../utils/db/index.js";
import { randomUUID } from "crypto";
import { Client, Pool } from "pg";
import Cursor from "pg-cursor";
import {
  BATCH_BYTES,
  BATCH_ROWS,
} from "../../../adapters/postgres/runQuery.js";
import {
  fixtureAdminSettings,
  fixtureSettings,
  fixtureTarget,
} from "../../support/fixtureDb.js";
import {
  QueryFailedError,
  QueryTimeoutError,
  SourceUnreachableError,
} from "../../../utils/errors.js";
import {
  removeSources,
  sourceSettings,
  uniqueSlug,
} from "../../support/sources.js";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const OPTIONS = { connectTimeoutMs: 5000, poolSize: 3, queryTimeoutMs: 5000 };
const LIMITS: RunLimits = {
  maxRows: 1000,
  maxBytes: 10 * 1024 * 1024,
  timeoutMs: 5000,
};

let connection: SourceConnection;
let catalog: VisibleCatalog;
const sources: string[] = [];
const opened: SourceConnection[] = [];

const plan = (query: object): SqlPlan =>
  planSql(
    sqlQuerySchema.parse({ source: catalog.source.slug, ...query }),
    catalog
  );

const run = (
  query: object,
  limits: Partial<RunLimits> = {},
  conn: SourceConnection = connection
) => conn.runQuery(plan(query), { ...LIMITS, ...limits });

const failureOf = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error("the query succeeded");
};

const asAdmin = async <T>(sql: string, values: unknown[] = []) => {
  const admin = new Client({ ...fixtureAdminSettings(), ssl: false });
  await admin.connect();
  try {
    return (await admin.query(sql, values)).rows as T[];
  } finally {
    await admin.end();
  }
};

/** Backends of the fixture database running a statement that reads `view`. */
const runningOn = (view: string) =>
  asAdmin<{ pid: number }>(
    `SELECT pid FROM pg_stat_activity
     WHERE datname = current_database() AND state = 'active'
       AND pid <> pg_backend_pid() AND query LIKE $1`,
    [`%${view}%`]
  );

const waitFor = async <T>(check: () => Promise<T[]>): Promise<T[]> => {
  for (let i = 0; i < 50; i++) {
    const found = await check();
    if (found.length > 0) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("never seen");
};

const connectWith = async (options = OPTIONS) => {
  const conn = await postgresAdapter.connect(
    fixtureSettings("ro"),
    await fixtureTarget(),
    options
  );
  opened.push(conn);
  return conn;
};

beforeAll(async () => {
  await initializeTereo();
  const id = randomUUID();
  sources.push(id);
  await prisma.source.create({
    data: {
      id,
      slug: uniqueSlug("query"),
      name: "Query test",
      type: "postgres",
      sealedSettings: sealSettings(sourceSettings("ro"), id) as object,
      schemas: ["sales", "probe"],
      createdBy: randomUUID(),
    },
  });
  await refreshSource(id, randomUUID());
  const source = (await db.sources.findById(id))!;
  const { tables, columns, relations } = await db.catalog.loadSourceCatalog(id);
  catalog = buildVisibleCatalog(source, tables, columns, relations, {
    sourceIds: new Set([id]),
    allows: () => true,
    tableAccess: () => "all",
  });
  connection = await connectWith();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await Promise.all(opened.map((c) => c.close()));
  await closeAllSourcePools();
  await removeSources(sources);
  await stopTereo();
});

describe("postgres runQuery", () => {
  it("returns every type in its wire form, whatever the login's session defaults", async () => {
    const result = await run({
      from: "typed_values",
      select: [
        "id",
        "small",
        "big",
        "single",
        "double",
        "exact",
        "flag",
        "day",
        "naive",
        "aware",
        "doc",
        "docb",
        "code",
      ],
      orderBy: [{ id: "asc" }],
    });
    expect(result.truncated).toBe(false);
    expect(result.columns).toEqual([
      { name: "id", type: "number" },
      { name: "small", type: "number" },
      { name: "big", type: "number" },
      { name: "single", type: "number" },
      { name: "double", type: "number" },
      { name: "exact", type: "number" },
      { name: "flag", type: "boolean" },
      { name: "day", type: "date" },
      { name: "naive", type: "timestamp" },
      { name: "aware", type: "timestamp" },
      { name: "doc", type: "json" },
      { name: "docb", type: "json" },
      { name: "code", type: "text" },
    ]);
    expect(result.rows).toEqual([
      [
        1,
        7,
        "9223372036854775807",
        1.5,
        0.30000000000000004,
        "12345678901234567890.123456789",
        true,
        "2026-03-31",
        "2026-03-31T23:59:59.123Z",
        "2026-03-31T21:59:59.987Z",
        { a: [1, 2] },
        { b: null },
        "6f1c1b2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b",
      ],
      [
        2,
        -32768,
        "-9223372036854775808",
        "NaN",
        "Infinity",
        "NaN",
        false,
        "infinity",
        "-infinity",
        "infinity",
        [],
        "text",
        null,
      ],
      [
        3,
        0,
        "0",
        "-Infinity",
        "-Infinity",
        "0",
        null,
        "0044-03-15 BC",
        "0099-01-01T00:00:00.000Z",
        "2000-01-01T04:00:00.000Z",
        null,
        1.5,
        null,
      ],
      [
        4,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
      ],
      [
        5,
        1,
        "1",
        3.25,
        1e300,
        "1.10",
        true,
        "2026-01-01",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
        { z: 1, a: 2 },
        { a: 2, z: 1 },
        null,
      ],
    ]);
  });

  it("reads the compiled LIKE escape as written, whatever the login's standard_conforming_strings", async () => {
    // The fixture login defaults to standard_conforming_strings = off, where
    // the compiled `escape '\\'` would open an escape instead of a string.
    expect(
      (
        await run({
          from: "customers",
          select: ["id"],
          where: { name: { contains: "100% Organic_" } },
        })
      ).rows
    ).toEqual([[2]]);
    expect(
      (
        await run({
          from: "customers",
          select: ["id"],
          where: { name: { startsWith: "acme" } },
        })
      ).rows
    ).toEqual([[1]]);
  });

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
    expect(result.columns.map((c) => c.name)).toEqual([
      "count",
      "countDistinct_customer_id",
      "sum_total",
      "avg_total",
      "max_total",
      "min_created_at",
    ]);
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

  it("reads a result far past the byte cap in a batch or two, not whole", async () => {
    const reads = vi.spyOn(Cursor.prototype, "read");
    const begun = Date.now();
    const result = await run(
      { from: "wide_rows", select: ["id", "filler"], orderBy: [{ id: "asc" }] },
      { maxRows: 50_000, maxBytes: 100_000 }
    );
    expect(result.truncated).toBe("bytes");
    expect(result.rows.length).toBeGreaterThan(40);
    expect(result.rows.length).toBeLessThan(50);
    expect(result.rows[0]).toEqual([1, "x".repeat(2048)]);
    // Asked of the server: at most two batches of the 50,001 rows allowed.
    const requested = reads.mock.calls.reduce((sum, [n]) => sum + n, 0);
    expect(requested).toBeGreaterThan(0);
    expect(requested).toBeLessThanOrEqual(2 * BATCH_ROWS);
    expect(Date.now() - begun).toBeLessThan(1000);
  });

  it("sizes each batch from the rows read so far, so one stays within its byte bound", async () => {
    const reads = vi.spyOn(Cursor.prototype, "read");
    const result = await run(
      { from: "huge_rows", select: ["id", "filler"], orderBy: [{ id: "asc" }] },
      { maxRows: 50_000, maxBytes: 3_000_000 }
    );
    expect(result.truncated).toBe("bytes");
    expect(result.rows).toHaveLength(9);
    const rowBytes = Buffer.byteLength(JSON.stringify(result.rows[0])) + 1;
    const asked = reads.mock.calls.map(([n]) => n);
    // One row before any width is known, then as many as fit the bound.
    expect(asked[0]).toBe(1);
    const fit = Math.floor(BATCH_BYTES / rowBytes);
    expect(fit).toBeGreaterThan(1);
    expect(asked.slice(1)).toEqual(asked.slice(1).map(() => fit));
    expect(fit * rowBytes).toBeLessThanOrEqual(BATCH_BYTES);
  });

  it("reads in batches across a row cap larger than one batch", async () => {
    const result = await run(
      { from: "wide_rows", select: ["id"], orderBy: [{ id: "asc" }] },
      { maxRows: 600 }
    );
    expect(result.rows).toHaveLength(600);
    expect(result.rows.at(-1)).toEqual([600]);
    expect(result.truncated).toBe("rows");
  });

  describe("safety", () => {
    it("runs inside a read-only transaction even when the session default allows writes", async () => {
      const pool = new Pool({
        ...toPgConfig(fixtureSettings("ro"), await fixtureTarget(), OPTIONS),
        options: undefined,
      });
      const bare = new PostgresConnection(pool);
      opened.push(bare);
      const session = await pool.query(
        "SELECT current_setting('default_transaction_read_only') AS ro"
      );
      expect(session.rows[0].ro).toBe("off");
      const result = await run(
        { from: "session_flags", select: ["read_only"] },
        {},
        bare
      );
      expect(result.rows).toEqual([["on"]]);
    });

    it("stops a query past its time limit with query_timeout and keeps the connection usable", async () => {
      const begun = Date.now();
      const err = await failureOf(
        run({ from: "slow_orders", select: ["id"] }, { timeoutMs: 500 })
      );
      expect(err).toBeInstanceOf(QueryTimeoutError);
      expect(Date.now() - begun).toBeLessThan(2500);
      expect(await runningOn("slow_orders")).toEqual([]);
      expect((await run({ from: "accounts", select: ["id"] })).rows).toEqual([
        [1],
        [2],
      ]);
    });

    it("stops at its own deadline when the server's statement timeout does not fire", async () => {
      const pool = new Pool(
        toPgConfig(fixtureSettings("ro"), await fixtureTarget(), {
          ...OPTIONS,
          queryTimeoutMs: 60_000,
        })
      );
      // Every statement on this pool runs with no server-side timeout.
      const connect = pool.connect.bind(pool);
      pool.connect = (async () => {
        const client = await connect();
        const query = client.query.bind(client) as (...a: unknown[]) => unknown;
        client.query = ((text: unknown, ...rest: unknown[]) =>
          query(
            typeof text === "string"
              ? text.replace(/statement_timeout = \d+/, "statement_timeout = 0")
              : text,
            ...rest
          )) as typeof client.query;
        return client;
      }) as typeof pool.connect;
      const unbounded = new PostgresConnection(pool);
      opened.push(unbounded);
      const begun = Date.now();
      const err = await failureOf(
        run(
          { from: "slow_orders", select: ["id"] },
          { timeoutMs: 500 },
          unbounded
        )
      );
      expect(err).toBeInstanceOf(QueryTimeoutError);
      expect(Date.now() - begun).toBeLessThan(1500);
      expect(await runningOn("slow_orders")).toEqual([]);
    });

    it("lets a query run past the pool's own query timeout when its limit is longer", async () => {
      const short = await connectWith({ ...OPTIONS, queryTimeoutMs: 1000 });
      const result = await run(
        { from: "slow_orders", select: ["id"], limit: 1 },
        { timeoutMs: 6000, maxRows: 1 },
        short
      );
      expect(result.rows).toEqual([[1]]);
      const err = await failureOf(
        run({ from: "slow_orders", select: ["id"] }, { timeoutMs: 500 }, short)
      );
      expect(err).toBeInstanceOf(QueryTimeoutError);
    });

    it("answers a failing query with query_failed and none of the database's text", async () => {
      const err = await failureOf(
        run({ from: "broken_orders", select: ["ratio"] })
      );
      expect(err).toBeInstanceOf(QueryFailedError);
      expect(err.message).toBe("The source could not run the query");
      expect(JSON.stringify(err)).not.toMatch(/division|zero|22012/i);
      expect((await run({ from: "accounts", select: ["id"] })).rows).toEqual([
        [1],
        [2],
      ]);
    });

    it("refuses a result whose columns are not the plan's", async () => {
      const planned = plan({ from: "accounts", select: ["id"] });
      const widened = {
        ...planned,
        columns: [...planned.columns, planned.columns[0]],
      };
      const err = await failureOf(connection.runQuery(widened, LIMITS));
      expect(err).toBeInstanceOf(QueryFailedError);
    });

    it("cancels the statement on the source when the signal aborts", async () => {
      const controller = new AbortController();
      const begun = Date.now();
      const running = connection.runQuery(
        plan({ from: "slow_orders", select: ["id"] }),
        { ...LIMITS, timeoutMs: 10_000 },
        controller.signal
      );
      await waitFor(() => runningOn("slow_orders"));
      controller.abort(new Error("client went away"));
      const err = await failureOf(running);
      expect(err.message).toBe("client went away");
      expect(Date.now() - begun).toBeLessThan(2500);
      expect(await runningOn("slow_orders")).toEqual([]);
      expect((await run({ from: "accounts", select: ["id"] })).rows).toEqual([
        [1],
        [2],
      ]);
    });

    it("cancels an aborted statement while every pool connection is in use", async () => {
      const full = await connectWith({ ...OPTIONS, poolSize: 2 });
      const first = new AbortController();
      const second = new AbortController();
      const slow = plan({ from: "slow_orders", select: ["id"] });
      const limits = { ...LIMITS, timeoutMs: 10_000 };
      const one = failureOf(full.runQuery(slow, limits, first.signal));
      const two = failureOf(full.runQuery(slow, limits, second.signal));
      await waitFor(async () =>
        (await runningOn("slow_orders")).length === 2 ? [true] : []
      );
      const begun = Date.now();
      first.abort(new Error("first gone"));
      expect((await one).message).toBe("first gone");
      expect(Date.now() - begun).toBeLessThan(1000);
      expect(await runningOn("slow_orders")).toHaveLength(1);
      second.abort(new Error("second gone"));
      expect((await two).message).toBe("second gone");
      expect(await runningOn("slow_orders")).toEqual([]);
    });

    it("cuts the connection, and rejects at once, when the cancel cannot be delivered", async () => {
      vi.spyOn(cancel, "sendCancelRequest").mockResolvedValue(false);
      const controller = new AbortController();
      const running = failureOf(
        connection.runQuery(
          plan({ from: "slow_orders", select: ["id"] }),
          { ...LIMITS, timeoutMs: 10_000 },
          controller.signal
        )
      );
      await waitFor(() => runningOn("slow_orders"));
      const begun = Date.now();
      controller.abort(new Error("gone"));
      expect((await running).message).toBe("gone");
      expect(Date.now() - begun).toBeLessThan(1000);
      // Undelivered, the cancel left the statement running on the server
      // until it next writes to the cut connection; later tests look for
      // their own statements there.
      for (const { pid } of await runningOn("slow_orders")) {
        await asAdmin("SELECT pg_terminate_backend($1)", [pid]);
      }
      vi.restoreAllMocks();
      expect((await run({ from: "accounts", select: ["id"] })).rows).toEqual([
        [1],
        [2],
      ]);
    });

    it("answers query_failed, not source_unreachable, for a local failure with no SQLSTATE", async () => {
      const planned = plan({ from: "accounts", select: ["id"] });
      const unserialisable = {
        toPostgres: () => {
          throw new Error("cannot serialise");
        },
      };
      const err = await failureOf(
        connection.runQuery(
          {
            ...planned,
            where: {
              kind: "compare",
              op: "eq",
              subject: planned.select[0].column as never,
              value: unserialisable as never,
            },
          } as SqlPlan,
          LIMITS
        )
      );
      expect(err).toBeInstanceOf(QueryFailedError);
      expect((await run({ from: "accounts", select: ["id"] })).rows).toEqual([
        [1],
        [2],
      ]);
    });

    it("runs nothing for a signal that has already aborted", async () => {
      const controller = new AbortController();
      controller.abort(new Error("gone"));
      const begun = Date.now();
      const err = await failureOf(
        connection.runQuery(
          plan({ from: "slow_orders", select: ["id"] }),
          LIMITS,
          controller.signal
        )
      );
      expect(err.message).toBe("gone");
      expect(Date.now() - begun).toBeLessThan(500);
    });

    it("answers source_unreachable when the server drops the connection mid-query", async () => {
      const running = failureOf(
        run({ from: "slow_orders", select: ["id"] }, { timeoutMs: 10_000 })
      );
      const [{ pid }] = await waitFor(() => runningOn("slow_orders"));
      await asAdmin("SELECT pg_terminate_backend($1)", [pid]);
      expect(await running).toBeInstanceOf(SourceUnreachableError);
      expect((await run({ from: "accounts", select: ["id"] })).rows).toEqual([
        [1],
        [2],
      ]);
    });
  });
});
