import { AzureSqlPreparedQuery } from "../../adapters/azure-sql/runQuery.js";
import { AzureSqlConnection } from "../../adapters/azure-sql/connect.js";
import { buildVisibleCatalog } from "../../grants/visibleCatalog.js";
import type { VisibleCatalog } from "../../grants/visibleCatalog.js";
import { toMssqlConfig } from "../../adapters/azure-sql/settings.js";
import { azureSqlAdapter } from "../../adapters/azure-sql/index.js";
import { initializeTereo, stopTereo } from "../../utils/tereo.js";
import { sqlQuerySchema } from "../../adapters/sql/language.js";
import { sealSettings } from "../../utils/crypto/envelope.js";
import { closeAllSourcePools } from "../../sources/pools.js";
import { afterAll, afterEach, beforeAll, vi } from "vitest";
import type { SqlPlan } from "../../adapters/sql/types.js";
import { removeSources, uniqueSlug } from "./sources.js";
import { refreshSource } from "../../catalog/refresh.js";
import { runPlan, type TestLimits } from "./runPlan.js";
import { planSql } from "../../adapters/sql/plan.js";
import { prisma } from "../../utils/db/prisma.js";
import { performance } from "node:perf_hooks";
import { db } from "../../utils/db/index.js";
import { randomUUID } from "crypto";
import sql from "mssql";
import type {
  OpenLimits,
  RowStream,
  SourceConnection,
} from "../../adapters/types.js";
import {
  mssqlFixtureSettings,
  mssqlFixtureTarget,
  mssqlSourceSettings,
  queryMssqlAdmin,
} from "./mssqlFixture.js";

// What the Azure SQL runQuery tests share: a source over the fixture's
// `sales` and `probe` schemas with everything visible, connections to it as
// the read-only login, and ways to see what runs on the server.

export const OPTIONS = {
  connectTimeoutMs: 5000,
  poolSize: 3,
  queryTimeoutMs: 5000,
};
export const LIMITS: TestLimits = {
  maxRows: 1000,
  maxBytes: 10 * 1024 * 1024,
  timeoutMs: 5000,
};

export const failureOf = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error("the query succeeded");
};

/**
 * Sessions of the fixture database running a statement that reads `view`,
 * by the text the client sent: the server's own statement text is that of
 * whatever function the statement is in.
 */
export const runningOn = (view: string) =>
  queryMssqlAdmin<{ session_id: number }>(
    `SELECT r.session_id FROM sys.dm_exec_requests r
      CROSS APPLY sys.dm_exec_input_buffer(r.session_id, r.request_id) b
      WHERE r.database_id = DB_ID() AND r.session_id <> @@SPID
        AND b.event_info LIKE @p0`,
    [`%${view}%`]
  );

export const kill = (sessionId: number) =>
  queryMssqlAdmin(`KILL ${Number(sessionId)}`);

/** Whether no session runs a statement reading `view` within `ms`. */
export const noneWithin = async (view: string, ms: number) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if ((await runningOn(view)).length === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
};

/** A run's time, from now, as the engine passes it to `openQuery`. */
export const limitsOf = (timeoutMs = 5000): OpenLimits => ({
  timeoutMs,
  deadlineAt: performance.now() + timeoutMs,
});

/** Every row the stream has left, read until it ends. */
export const drain = async (stream: RowStream): Promise<unknown[][]> => {
  const rows: unknown[][] = [];
  for (;;) {
    const batch = await stream.next(250);
    if (batch.length === 0) return rows;
    rows.push(...batch);
  }
};

export const waitFor = async <T>(check: () => Promise<T[]>): Promise<T[]> => {
  for (let i = 0; i < 100; i++) {
    const found = await check();
    if (found.length > 0) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("never seen");
};

/** Registers the file's hooks; the source and the shared connection exist from `beforeAll` on. */
export const useMssqlRuns = () => {
  let connection: SourceConnection;
  let catalog: VisibleCatalog;
  const sources: string[] = [];
  const opened: SourceConnection[] = [];

  const connectWith = async (options = OPTIONS) => {
    const conn = await azureSqlAdapter.connect(
      mssqlFixtureSettings("ro"),
      await mssqlFixtureTarget(),
      options
    );
    opened.push(conn);
    return conn;
  };

  /** A connection over a pool built from the adapter's own config, with driver `options` changed. */
  const connectWithDriverOptions = async (
    options: Partial<sql.config["options"]>,
    connectOptions = OPTIONS
  ) => {
    const config = toMssqlConfig(
      mssqlFixtureSettings("ro"),
      await mssqlFixtureTarget(),
      connectOptions
    );
    const pool = new sql.ConnectionPool({
      ...config,
      options: { ...config.options, ...options },
    });
    pool.on("error", () => undefined);
    await pool.connect();
    const conn = new AzureSqlConnection(pool);
    opened.push(conn);
    return conn;
  };

  const plan = (query: object): SqlPlan =>
    planSql(
      sqlQuerySchema.parse({ source: catalog.source.slug, ...query }),
      catalog
    );

  const run = (
    query: object,
    limits: Partial<TestLimits> = {},
    conn: SourceConnection = connection
  ) => runPlan("azure-sql", conn, plan(query), { ...LIMITS, ...limits });

  /** Opens `query` as a row stream, prepared for every row it has. */
  const open = (
    query: object,
    timeoutMs = 5000,
    conn: SourceConnection = connection,
    signal?: AbortSignal
  ) => {
    const planned = plan(query);
    return conn.openQuery(
      azureSqlAdapter.prepare(planned, {
        limit: 1_000_000,
        offset: planned.offset,
      }),
      limitsOf(timeoutMs),
      signal
    );
  };

  /**
   * The numbers 1 to `rows` as bigint text, each with 2 KB of filler, made on
   * the fly: far more than the network between the server and the driver
   * buffers. The statement's text carries `counting_rows` for `runningOn`.
   */
  const counting = (rows: number) =>
    new AzureSqlPreparedQuery(
      plan({ from: "wide_rows", select: ["id", "filler"] }),
      `SELECT TOP (${Number(rows)})
              ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS c0,
              CAST(REPLICATE('x', 2048) AS varchar(2048)) AS c1
         /* counting_rows */
         FROM sys.all_columns a CROSS JOIN sys.all_columns b`,
      []
    );

  beforeAll(async () => {
    await initializeTereo();
    const id = randomUUID();
    sources.push(id);
    await prisma.source.create({
      data: {
        id,
        slug: uniqueSlug("query"),
        name: "Azure SQL query test",
        type: "azure_sql",
        sealedSettings: sealSettings(mssqlSourceSettings("ro"), id) as object,
        schemas: ["sales", "probe"],
        createdBy: randomUUID(),
      },
    });
    await refreshSource(id, randomUUID());
    const source = (await db.sources.findById(id))!;
    const { tables, columns, relations } =
      await db.catalog.loadSourceCatalog(id);
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

  return {
    /** The shared connection, pool size 3. */
    connection: () => connection,
    connectWith,
    connectWithDriverOptions,
    counting,
    open,
    plan,
    run,
  };
};
