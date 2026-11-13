// @module-tag int
// @module-tag platform
import { fixtureSettings, fixtureTarget } from "../../support/fixtureDb.js";
import { PostgresConnection } from "../../../adapters/postgres/connect.js";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { toPgConfig } from "../../../adapters/postgres/settings.js";
import { SourceUnreachableError } from "../../../utils/errors.js";
import { fixtureAdminSettings } from "../../support/fixtureDb.js";
import * as cancel from "../../../adapters/postgres/cancel.js";
import type { SqlPlan } from "../../../adapters/sql/types.js";
import type { RunLimits } from "../../../adapters/types.js";
import type { EventEmitter } from "events";
import { Client, Pool } from "pg";

// The connection dropping while pg-cursor waits for the server's
// ReadyForQuery after it has closed its portal: pg-cursor ignores errors once
// it has sent Close and Sync, so only the run itself can notice. The window
// is one round trip, too narrow to hit from outside, so the tests hold that
// ReadyForQuery back on the client's connection and drop the connection
// meanwhile.

const LIMITS: RunLimits = {
  maxRows: 1000,
  maxBytes: 1_000_000,
  timeoutMs: 5000,
};

/** `select id from sales.accounts order by id`, as the planner would make it. */
const accountIds = (): SqlPlan => ({
  from: { alias: "t0", schemaName: "sales", name: "accounts" },
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

const pools: Pool[] = [];

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await Promise.all(pools.map((p) => p.end()));
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

describe("postgres runQuery: the connection lost after the cursor's Sync", () => {
  it("rejects promptly, and destroys the client, when the rows ended naturally", async () => {
    const { pool, connection } = await droppingAfterSync();
    const begun = Date.now();
    await expect(
      connection.runQuery(accountIds(), LIMITS)
    ).rejects.toBeInstanceOf(SourceUnreachableError);
    expect(Date.now() - begun).toBeLessThan(2000);
    expect(checkedOut(pool)).toBe(0);
  });

  it("rejects promptly, and destroys the client, when closing a truncated read", async () => {
    const { pool, connection } = await droppingAfterSync();
    const begun = Date.now();
    await expect(
      connection.runQuery(accountIds(), { ...LIMITS, maxRows: 1 })
    ).rejects.toBeInstanceOf(SourceUnreachableError);
    expect(Date.now() - begun).toBeLessThan(2000);
    expect(checkedOut(pool)).toBe(0);
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
    const running = connection.runQuery(slow, LIMITS, controller.signal);
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
