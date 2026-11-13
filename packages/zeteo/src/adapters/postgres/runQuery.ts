import { normaliseValue, type WireKind } from "../sql/values.js";
import { postgresDialect } from "../sql/dialects/postgres.js";
import type { QueryResult, RunLimits } from "../types.js";
import { logger } from "../../utils/logger.js";
import type { SqlPlan } from "../sql/types.js";
import { compileSql } from "../sql/compile.js";
import {
  AppError,
  QueryFailedError,
  QueryTimeoutError,
  ServiceUnavailableError,
  SourceUnreachableError,
} from "../../utils/errors.js";
import {
  DatabaseError,
  type FieldDef,
  type Pool,
  type PoolClient,
  type QueryArrayConfig,
  type QueryArrayResult,
} from "pg";

// Wire forms by the result field's type OID. A domain arrives as its base
// type; every type not listed (enums, uuid, citext, money…) travels as text.
const WIRE_BY_OID: ReadonlyMap<number, WireKind> = new Map([
  [16, "boolean"],
  [20, "int64"],
  [21, "number"],
  [23, "number"],
  [700, "number"],
  [701, "number"],
  [1700, "decimal"],
  [1082, "date"],
  [1114, "timestamp"],
  [1184, "timestamp"],
  [114, "json"],
  [3802, "json"],
]);

const wireOf = (field: FieldDef): WireKind =>
  WIRE_BY_OID.get(field.dataTypeID) ?? "text";

// Every value arrives as the text the server printed, never through pg's
// global parsers, which read dates in the process's time zone and int8 and
// numeric lossily.
const RAW_TEXT = { getTypeParser: () => (text: string) => text };

/** How long past the server's own timeout the client waits before giving up on the connection. */
const CLIENT_GRACE_MS = 2000;

const QUERY_CANCELED = "57014";
// Class 08 is a connection exception; 57P01 to 57P03, the server shutting
// down, crashing or not yet accepting connections.
const CONNECTION_CODES = ["57P01", "57P02", "57P03"];
const POOL_EXHAUSTED = "timeout exceeded when trying to connect";
const CLIENT_READ_TIMEOUT = "Query read timeout";
const BUSY_RETRY_AFTER_SECONDS = 1;

// Pins the forms the server prints values in, whatever the login's defaults:
// timestamptz in UTC, ISO dates, floats with every digit.
const sessionSetup = (timeoutMs: number) =>
  [
    "BEGIN TRANSACTION READ ONLY",
    `SET LOCAL statement_timeout = ${timeoutMs}`,
    "SET LOCAL TIME ZONE 'UTC'",
    "SET LOCAL DateStyle = 'ISO, YMD'",
    "SET LOCAL extra_float_digits = 1",
  ].join("; ");

const isClientReadTimeout = (err: unknown): boolean =>
  err instanceof Error && err.message === CLIENT_READ_TIMEOUT;

/**
 * A driver error as the caller's; the driver's text goes only to the log.
 * Errors without a SQLSTATE come from the connection itself.
 */
const callerError = (err: unknown): AppError => {
  if (isClientReadTimeout(err)) {
    logger.warn({ err }, "source query outlived its server-side timeout");
    return new QueryTimeoutError();
  }
  if (!(err instanceof DatabaseError)) {
    logger.warn({ err }, "source connection failed during a query");
    return new SourceUnreachableError();
  }
  if (err.code === QUERY_CANCELED) return new QueryTimeoutError();
  if (err.code?.startsWith("08") || CONNECTION_CODES.includes(err.code ?? "")) {
    logger.warn({ err }, "source connection failed during a query");
    return new SourceUnreachableError();
  }
  logger.warn({ err }, "source query failed");
  return new QueryFailedError();
};

/** Maps result columns to the plan's by position: the compiler aliases them c0, c1… */
const checkFields = (fields: FieldDef[], plan: SqlPlan): void => {
  const expected = plan.columns.map((_, i) => `c${i}`);
  const names = fields.map((f) => f.name);
  if (
    names.length !== expected.length ||
    names.some((name, i) => name !== expected[i])
  ) {
    logger.error(
      { fields: names, expected },
      "result columns do not match the plan"
    );
    throw new QueryFailedError();
  }
};

/**
 * Normalises rows in order until `maxRows` are kept or the next would pass
 * `maxBytes`. A row's size is its JSON plus one byte for the comma after it.
 */
const collect = (
  result: QueryArrayResult,
  plan: SqlPlan,
  limits: RunLimits
): QueryResult => {
  checkFields(result.fields, plan);
  const wires = result.fields.map(wireOf);
  const rows: unknown[][] = [];
  let bytes = 0;
  let truncated: QueryResult["truncated"] = false;
  for (const raw of result.rows) {
    if (rows.length === limits.maxRows) {
      truncated = "rows";
      break;
    }
    const row = raw.map((value, i) =>
      normaliseValue(value as string | null, wires[i])
    );
    bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
    if (bytes > limits.maxBytes) {
      truncated = "bytes";
      break;
    }
    rows.push(row);
  }
  return {
    columns: plan.columns.map(({ name, type }) => ({ name, type })),
    rows,
    truncated,
  };
};

const checkout = async (pool: Pool): Promise<PoolClient> => {
  try {
    return await pool.connect();
  } catch (err) {
    logger.warn({ err }, "no connection to the source for a query");
    // A pool with every connection in use is busy, not broken: it is kept.
    if (err instanceof Error && err.message === POOL_EXHAUSTED) {
      throw new ServiceUnavailableError(
        "The source is busy; retry the request shortly",
        BUSY_RETRY_AFTER_SECONDS
      );
    }
    throw new SourceUnreachableError();
  }
};

/** Stops the backend's running statement, from another of the pool's connections. */
const cancelOnServer = async (pool: Pool, pid: number): Promise<void> => {
  try {
    await pool.query("SELECT pg_cancel_backend($1)", [pid]);
  } catch (err) {
    logger.warn({ err }, "cancelling a source query failed");
  }
};

/** Rolls back and returns the client to the pool, or destroys it when it cannot be trusted. */
const finish = async (client: PoolClient, broken: unknown): Promise<void> => {
  if (broken === undefined) {
    try {
      await client.query("ROLLBACK");
      client.release();
      return;
    } catch (err) {
      broken = err;
    }
  }
  client.release(broken instanceof Error ? broken : true);
};

/**
 * Runs a compiled plan on its own client inside a read-only transaction that
 * is always rolled back. The server stops the statement at `timeoutMs`; the
 * client gives up `CLIENT_GRACE_MS` later. Asks for one row past `maxRows` to
 * tell whether more exist.
 */
export const runPostgresQuery = async (
  pool: Pool,
  plan: SqlPlan,
  limits: RunLimits,
  signal?: AbortSignal
): Promise<QueryResult> => {
  // The timeout is written into the SQL text, so only a whole number may be.
  if (!Number.isSafeInteger(limits.timeoutMs) || limits.timeoutMs <= 0) {
    throw new Error(`invalid query timeout: ${limits.timeoutMs}`);
  }
  signal?.throwIfAborted();
  const { sql, parameters } = compileSql(plan, postgresDialect, {
    limit: limits.maxRows + 1,
    offset: plan.offset,
  });

  const client = await checkout(pool);
  let broken: unknown;
  // A checked-out client that loses its connection emits `error`; unheard,
  // it would crash the process.
  const onClientError = (err: Error) => {
    broken = err;
  };
  client.on("error", onClientError);
  let running = false;
  let cancelling: Promise<void> | undefined;
  const onAbort = () => {
    // pg sets the backend's pid on every connected client; its types omit it.
    const { processID } = client as PoolClient & { processID: number };
    if (running) cancelling = cancelOnServer(pool, processID);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  let result: QueryArrayResult;
  try {
    await client.query(sessionSetup(limits.timeoutMs));
    signal?.throwIfAborted();
    running = true;
    // A per-query `query_timeout` replaces the pool's own (pg reads the
    // query's first), so the catalogue's shorter limit never applies here.
    const query: QueryArrayConfig & { query_timeout: number } = {
      text: sql,
      values: parameters,
      rowMode: "array",
      types: RAW_TEXT,
      query_timeout: limits.timeoutMs + CLIENT_GRACE_MS,
    };
    try {
      result = await client.query(query);
    } finally {
      running = false;
    }
  } catch (err) {
    if (signal?.aborted) throw signal.reason;
    const failure = callerError(err);
    // A client that timed out on its side is still busy with the statement;
    // one whose connection failed is gone.
    if (failure instanceof SourceUnreachableError || isClientReadTimeout(err)) {
      broken ??= err;
    }
    throw failure;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    // The cancel must land while this client is still ours: once released,
    // its backend may be running someone else's statement.
    await cancelling;
    await finish(client, broken);
    client.off("error", onClientError);
  }
  return collect(result, plan, limits);
};
