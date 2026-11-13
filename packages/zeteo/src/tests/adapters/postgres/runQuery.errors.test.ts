// @module-tag int
// @module-tag platform
import { prepareAzureSqlQuery } from "../../../adapters/azure-sql/runQuery.js";
import { preparePostgresQuery } from "../../../adapters/postgres/runQuery.js";
import { fixtureSettings, fixtureTarget } from "../../support/fixtureDb.js";
import { PostgresConnection } from "../../../adapters/postgres/connect.js";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { azureSqlAdapter } from "../../../adapters/azure-sql/index.js";
import { postgresAdapter } from "../../../adapters/postgres/index.js";
import { runPlan, type TestLimits } from "../../support/runPlan.js";
import { toPgConfig } from "../../../adapters/postgres/settings.js";
import type { SourceConnection } from "../../../adapters/types.js";
import { fixtureAdminSettings } from "../../support/fixtureDb.js";
import * as cancel from "../../../adapters/postgres/cancel.js";
import type { SqlPlan } from "../../../adapters/sql/types.js";
import { performance } from "node:perf_hooks";
import type { EventEmitter } from "events";
import { Client, Pool } from "pg";
import {
  mssqlFixtureSettings,
  mssqlFixtureTarget,
} from "../../support/mssqlFixture.js";
import {
  AppError,
  QueryTimeoutError,
  ServiceUnavailableError,
  SourceUnreachableError,
} from "../../../utils/errors.js";

const LIMITS: TestLimits = {
  maxRows: 1000,
  maxBytes: 1_000_000,
  timeoutMs: 5000,
};

const accountIds = (): SqlPlan => idsOf("sales", "accounts");

const pools: Pool[] = [];
const opened: SourceConnection[] = [];

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await Promise.all(pools.map((p) => p.end()));
  await Promise.all(opened.map((c) => c.close()));
});

const terminate = async (pid: number) => {
  const admin = new Client({ ...fixtureAdminSettings(), ssl: false });
  await admin.connect();
  try {
    await admin.query("SELECT pg_terminate_backend($1)", [pid]);
  } finally {
    await admin.end();
  }
};

/**
 * A connection whose clients hold back their second ReadyForQuery after
 * checkout (the first answers the run's session setup; the second follows
 * the cursor's Sync) and terminate their backend instead.
 */
const droppingAfterSync = async () => {
  const pool = new Pool(
    toPgConfig(fixtureSettings("ro"), await fixtureTarget(), {
      connectTimeoutMs: 5000,
      poolSize: 2,
      queryTimeoutMs: 5000,
    })
  );
  pools.push(pool);
  const connect = pool.connect.bind(pool);
  pool.connect = (async () => {
    const client = await connect();
    const { connection, processID } = client as unknown as {
      connection: EventEmitter;
      processID: number;
    };
    const emit = connection.emit.bind(connection);
    let seen = 0;
    connection.emit = ((event: string, ...args: unknown[]) => {
      if (event === "readyForQuery" && ++seen === 2) {
        void terminate(processID);
        return true;
      }
      return emit(event, ...args);
    }) as typeof connection.emit;
    return client;
  }) as typeof pool.connect;
  return { pool, connection: new PostgresConnection(pool) };
};

const checkedOut = (pool: Pool) => pool.totalCount - pool.idleCount;

// The connection dropping while pg-cursor waits for the server's
// ReadyForQuery after it has closed its portal: pg-cursor ignores errors once
// it has sent Close and Sync, so only the run itself can notice. The window
// is one round trip, too narrow to hit from outside, so the tests hold that
// ReadyForQuery back on the client's connection and drop the connection
// meanwhile.
describe("postgres runQuery: the connection lost after the cursor's Sync", () => {
  it("rejects promptly, and destroys the client, when the rows ended naturally", async () => {
    const { pool, connection } = await droppingAfterSync();
    const begun = Date.now();
    await expect(
      runPlan("postgres", connection, accountIds(), LIMITS)
    ).rejects.toBeInstanceOf(SourceUnreachableError);
    expect(Date.now() - begun).toBeLessThan(2000);
    expect(checkedOut(pool)).toBe(0);
  });

  it("closes a truncated read promptly, keeping its rows, and destroys the client", async () => {
    const { pool, connection } = await droppingAfterSync();
    const begun = Date.now();
    // The rows were read before the cursor was closed; closing never throws.
    await expect(
      runPlan("postgres", connection, accountIds(), { ...LIMITS, maxRows: 1 })
    ).resolves.toMatchObject({ rows: [[1]], truncated: "rows" });
    expect(Date.now() - begun).toBeLessThan(2000);
    expect(checkedOut(pool)).toBe(0);
    expect(pool.totalCount).toBe(0);
  });
});

describe("postgres runQuery: a cancel that is not confirmed", () => {
  it("destroys the client rather than return it to the pool", async () => {
    const pool = new Pool(
      toPgConfig(fixtureSettings("ro"), await fixtureTarget(), {
        connectTimeoutMs: 5000,
        poolSize: 2,
        queryTimeoutMs: 5000,
      })
    );
    pools.push(pool);
    const connection = new PostgresConnection(pool);
    // Written, perhaps, but never answered: it may yet land.
    vi.spyOn(cancel, "sendCancelRequest").mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(false), 200))
    );
    const controller = new AbortController();
    const slow: SqlPlan = {
      ...accountIds(),
      from: { alias: "t0", schemaName: "sales", name: "slow_orders" },
    };
    const running = runPlan(
      "postgres",
      connection,
      slow,
      LIMITS,
      controller.signal
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    controller.abort(new Error("gone"));
    await expect(running).rejects.toThrow("gone");
    expect(pool.totalCount).toBe(0);
    // Never cancelled, the statement still runs on the server; later tests
    // look for their own there.
    const admin = new Client({ ...fixtureAdminSettings(), ssl: false });
    await admin.connect();
    try {
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid()
           AND query LIKE '%slow_orders%'`
      );
    } finally {
      await admin.end();
    }
  });
});

const OPTIONS = { connectTimeoutMs: 5000, poolSize: 1, queryTimeoutMs: 5000 };

const connectWith = async (options = OPTIONS) => {
  const conn = (await postgresAdapter.connect(
    fixtureSettings("ro"),
    await fixtureTarget(),
    options
  )) as PostgresConnection;
  opened.push(conn);
  return conn;
};

/** `select id from <schema>.<name> order by id`, as the planner would make it. */
const idsOf = (schemaName: string, name: string): SqlPlan => ({
  from: { alias: "t0", schemaName, name },
  joins: [],
  select: [
    {
      kind: "column",
      column: {
        alias: "t0",
        name: "id",
        type: "number",
        nativeType: "integer",
      },
      output: "id",
      type: "number",
    },
  ],
  distinct: false,
  where: undefined,
  groupBy: [],
  having: undefined,
  orderBy: [{ target: { kind: "output", index: 0 }, direction: "asc" }],
  references: [],
  columns: [{ name: "id", type: "number", references: [] }],
  warnings: [],
  limit: undefined,
  offset: 0,
});

const prepared = (plan: SqlPlan, limit = 100_000) =>
  preparePostgresQuery(plan, { limit, offset: 0 });

const limitsOf = (timeoutMs = 5000) => ({
  timeoutMs,
  deadlineAt: performance.now() + timeoutMs,
});

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

const noneWithin = async (view: string, ms: number) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if ((await runningOn(view)).length === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
};

const inUse = (conn: PostgresConnection) =>
  conn.pool.totalCount - conn.pool.idleCount;

/** Every row the stream has left, read until it ends. */
const drain = async (stream: { next(n: number): Promise<unknown[][]> }) => {
  const rows: unknown[][] = [];
  for (;;) {
    const batch = await stream.next(100);
    if (batch.length === 0) return rows;
    rows.push(...batch);
  }
};

const ACCOUNTS = [[1], [2]];

describe("postgres openQuery: the row stream", () => {
  it("knows its columns once open and returns [] after the end, however often asked", async () => {
    const conn = await connectWith();
    const stream = await conn.openQuery(
      prepared(idsOf("sales", "orders")),
      limitsOf()
    );
    expect(stream.columns).toEqual([{ name: "id", type: "number" }]);
    const rows = await drain(stream);
    expect(rows).toEqual(Array.from({ length: 12 }, (_, i) => [i + 1]));
    expect(await stream.next(5)).toEqual([]);
    expect(await stream.next(5)).toEqual([]);
    await stream.close();
    expect(inUse(conn)).toBe(0);
  });

  it("refuses to read zero rows, which the protocol would take as all of them", async () => {
    const conn = await connectWith();
    const stream = await conn.openQuery(
      prepared(idsOf("sales", "orders")),
      limitsOf()
    );
    try {
      await expect(stream.next(0)).rejects.toThrow();
    } finally {
      await stream.close();
    }
  });

  it("stops the statement on the server when closed mid-result, and the pool gives the connection out again", async () => {
    const conn = await connectWith();
    const stream = await conn.openQuery(
      prepared(idsOf("probe", "wide_rows")),
      limitsOf(10_000)
    );
    expect((await stream.next(10)).length).toBeGreaterThan(0);
    expect(await runningOn("wide_rows")).toHaveLength(1);
    await stream.close();
    expect(await noneWithin("wide_rows", 2000)).toBe(true);
    expect(inUse(conn)).toBe(0);
    // The pool holds one connection: this run gets it.
    const again = await conn.openQuery(
      prepared(idsOf("sales", "accounts")),
      limitsOf()
    );
    try {
      expect(await drain(again)).toEqual(ACCOUNTS);
    } finally {
      await again.close();
    }
  });

  it("closes harmlessly twice, and at once", async () => {
    const conn = await connectWith();
    const stream = await conn.openQuery(
      prepared(idsOf("probe", "wide_rows")),
      limitsOf()
    );
    await stream.next(1);
    await Promise.all([stream.close(), stream.close()]);
    await expect(stream.close()).resolves.toBeUndefined();
    expect(inUse(conn)).toBe(0);
    const again = await conn.openQuery(
      prepared(idsOf("sales", "accounts")),
      limitsOf()
    );
    try {
      expect(await drain(again)).toEqual(ACCOUNTS);
    } finally {
      await again.close();
    }
  });

  it("rejects the next read with the signal's reason after an abort between reads, and every read after it", async () => {
    const conn = await connectWith();
    const controller = new AbortController();
    const stream = await conn.openQuery(
      prepared(idsOf("probe", "wide_rows")),
      limitsOf(10_000),
      controller.signal
    );
    await stream.next(1);
    const reason = new Error("client went away");
    controller.abort(reason);
    await expect(stream.next(5)).rejects.toBe(reason);
    await expect(stream.next(5)).rejects.toBe(reason);
    await stream.close();
    expect(await noneWithin("wide_rows", 2000)).toBe(true);
    expect(inUse(conn)).toBe(0);
    const again = await conn.openQuery(
      prepared(idsOf("sales", "accounts")),
      limitsOf()
    );
    try {
      expect(await drain(again)).toEqual(ACCOUNTS);
    } finally {
      await again.close();
    }
  });

  it("rejects a read with source_unreachable when the connection is lost, without hanging", async () => {
    const conn = await connectWith();
    const stream = await conn.openQuery(
      prepared(idsOf("probe", "wide_rows")),
      limitsOf(10_000)
    );
    await stream.next(1);
    const [{ pid }] = await runningOn("wide_rows");
    await asAdmin("SELECT pg_terminate_backend($1)", [pid]);
    const begun = Date.now();
    const err = await stream.next(250).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(SourceUnreachableError);
    await expect(stream.next(250)).rejects.toBe(err);
    await stream.close();
    expect(Date.now() - begun).toBeLessThan(2000);
    expect(inUse(conn)).toBe(0);
  });

  it("answers query_timeout, not source_busy, when the pool is exhausted after the deadline has passed", async () => {
    const conn = await connectWith({ ...OPTIONS, connectTimeoutMs: 300 });
    const held = await conn.pool.connect();
    try {
      const late = await conn
        .openQuery(prepared(idsOf("sales", "accounts")), limitsOf(100))
        .then(
          () => undefined,
          (e: unknown) => e
        );
      expect(late).toBeInstanceOf(QueryTimeoutError);
      const busy = await conn
        .openQuery(prepared(idsOf("sales", "accounts")), limitsOf(5000))
        .then(
          () => undefined,
          (e: unknown) => e
        );
      expect(busy).toBeInstanceOf(ServiceUnavailableError);
    } finally {
      held.release();
    }
  });

  it("refuses a query an Azure SQL adapter prepared, loudly", async () => {
    const conn = await connectWith();
    const foreign = prepareAzureSqlQuery(idsOf("sales", "accounts"), {
      limit: 10,
      offset: 0,
    });
    const err = await conn.openQuery(foreign, limitsOf()).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AppError);
    expect(inUse(conn)).toBe(0);
  });

  it("is refused by an Azure SQL connection, loudly", async () => {
    const conn = await azureSqlAdapter.connect(
      mssqlFixtureSettings("ro"),
      await mssqlFixtureTarget(),
      OPTIONS
    );
    opened.push(conn);
    const limits = { ...limitsOf(), maxRows: 10, maxBytes: 1_000_000 };
    const err = await conn
      .openQuery(prepared(idsOf("sales", "accounts")), limits)
      .then(
        () => undefined,
        (e: unknown) => e
      );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AppError);
  });
});
