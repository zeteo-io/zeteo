import { DatabaseError, type FieldDef, type Pool, type PoolClient } from "pg";
import { sendCancelRequest, type CancelTarget } from "./cancel.js";
import { normaliseValue, type WireKind } from "../sql/values.js";
import { postgresDialect } from "../sql/dialects/postgres.js";
import type { QueryResult, RunLimits } from "../types.js";
import { invalidValue } from "../../engine/errors.js";
import { logger } from "../../utils/logger.js";
import type { SqlPlan } from "../sql/types.js";
import { compileSql } from "../sql/compile.js";
import Cursor from "pg-cursor";
import {
  AppError,
  QueryFailedError,
  QueryTimeoutError,
  sourceBusy,
  SourceUnreachableError,
} from "../../utils/errors.js";

// pg-pool's error, which carries no code, for a checkout that waited past the
// connect timeout while every connection was in use.
const POOL_EXHAUSTED = "timeout exceeded when trying to connect";

/** Whether the pool had no connection free in time. */
export const isPoolExhausted = (err: unknown): boolean =>
  err instanceof Error && err.message === POOL_EXHAUSTED;

// Wire forms by the result field's type OID. A domain arrives as its base
// type; every type not listed (enums, uuid, citext…) travels as text. Money
// never arrives as such: the dialect reads it as numeric.
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

/** The most rows fetched per round trip. */
export const BATCH_ROWS = 250;
/**
 * About the most bytes one batch holds beyond the rows the run keeps: each
 * batch after the first is sized from the average row read so far.
 */
export const BATCH_BYTES = 1024 * 1024;
/** The first batch, read before any row's width is known. */
const FIRST_BATCH_ROWS = 1;
/** How long past the run's deadline the client waits on the connection before giving up on it. */
const CLIENT_GRACE_MS = 2000;
/** How long a cancelled statement gets to end before its connection is cut. */
const STOP_GRACE_MS = 1000;

const QUERY_CANCELED = "57014";
// Data exceptions a bound value raises when the server converts it to the
// column's type: invalid text (22P02), datetime format, field and time zone
// (22007, 22008, 22009), a number out of range (22003).
const VALUE_CODES = new Set(["22P02", "22007", "22008", "22009", "22003"]);
// Class 08 is a connection exception; 57P01 to 57P03, the server shutting
// down, crashing or not yet accepting connections.
const CONNECTION_CODES = ["57P01", "57P02", "57P03"];
// The socket's own failures, and pg's errors for a connection that ended.
const SOCKET_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
]);
const CONNECTION_MESSAGES = new Set([
  "Connection terminated",
  "Connection terminated unexpectedly",
  "Client has encountered a connection error and is not queryable",
  "Client was closed and is not queryable",
]);
const CLIENT_READ_TIMEOUT = "Query read timeout";

// Pins the forms the server prints values in, whatever the login's defaults:
// timestamptz in UTC, ISO dates, floats with every digit (3 is full precision
// before Postgres 12 and the same as 1 since); and how it reads the compiled
// SQL: a backslash in a string literal (LIKE's `escape '\'`) is itself.
const sessionSetup = (timeoutMs: number) =>
  [
    "BEGIN TRANSACTION READ ONLY",
    `SET LOCAL statement_timeout = ${timeoutMs}`,
    "SET LOCAL TIME ZONE 'UTC'",
    "SET LOCAL DateStyle = 'ISO, YMD'",
    "SET LOCAL extra_float_digits = 3",
    "SET LOCAL standard_conforming_strings = on",
  ].join("; ");

const isClientReadTimeout = (err: unknown): boolean =>
  err instanceof Error && err.message === CLIENT_READ_TIMEOUT;

const isConnectionFailure = (err: unknown): boolean => {
  if (err instanceof DatabaseError) {
    return (
      err.code?.startsWith("08") === true ||
      CONNECTION_CODES.includes(err.code ?? "")
    );
  }
  return (
    err instanceof Error &&
    (SOCKET_ERROR_CODES.has((err as NodeJS.ErrnoException).code ?? "") ||
      CONNECTION_MESSAGES.has(err.message))
  );
};

/** A driver error as the caller's; the driver's text goes only to the log. */
const callerError = (err: unknown): AppError => {
  if (err instanceof AppError) return err;
  if (isClientReadTimeout(err)) {
    logger.warn({ err }, "source query outlived its deadline on the client");
    return new QueryTimeoutError();
  }
  if (err instanceof DatabaseError && err.code === QUERY_CANCELED) {
    return new QueryTimeoutError();
  }
  if (err instanceof DatabaseError && VALUE_CODES.has(err.code ?? "")) {
    logger.info({ err }, "the source could not convert a query's value");
    return invalidValue();
  }
  if (isConnectionFailure(err)) {
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

const readBatch = (
  cursor: Cursor<unknown[]>,
  count: number
): Promise<{ rows: unknown[][]; fields: FieldDef[] }> =>
  new Promise((resolve, reject) => {
    cursor.read(count, (err, rows, result) => {
      if (err) reject(err);
      else resolve({ rows, fields: result.fields });
    });
  });

/**
 * Reads the cursor in batches, normalising as it goes, until `maxRows` rows
 * are kept and one more exists, the next row would pass `maxBytes`, or the
 * rows end. A row's size is its JSON plus one byte for the comma after it.
 * The first batch is one row; each later one as many rows of the average
 * size so far as fit `BATCH_BYTES`, at least one and at most `BATCH_ROWS`,
 * so a result of wide rows is not buffered whole before the byte cap applies.
 */
const readRows = async (
  cursor: Cursor<unknown[]>,
  plan: SqlPlan,
  limits: RunLimits,
  checkStop: () => void,
  guard: <T>(step: Promise<T>) => Promise<T>
): Promise<Pick<QueryResult, "rows" | "truncated">> => {
  const rows: unknown[][] = [];
  let wires: WireKind[] | undefined;
  let fetched = 0;
  let bytes = 0;
  for (;;) {
    // Every row read so far is kept and counted in `bytes`: the run returns
    // at the first one it does not keep.
    const fits =
      rows.length === 0
        ? FIRST_BATCH_ROWS
        : Math.floor(BATCH_BYTES / (bytes / rows.length));
    const want = Math.min(
      Math.max(1, Math.min(BATCH_ROWS, fits)),
      limits.maxRows + 1 - fetched
    );
    const batch = await guard(readBatch(cursor, want));
    checkStop();
    if (!wires) {
      checkFields(batch.fields, plan);
      wires = batch.fields.map(wireOf);
    }
    fetched += batch.rows.length;
    for (const raw of batch.rows) {
      if (rows.length === limits.maxRows) return { rows, truncated: "rows" };
      const row = raw.map((value, i) =>
        normaliseValue(value as string | null, wires![i])
      );
      bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
      if (bytes > limits.maxBytes) return { rows, truncated: "bytes" };
      rows.push(row);
    }
    if (batch.rows.length < want) return { rows, truncated: false };
  }
};

const checkout = async (pool: Pool): Promise<PoolClient> => {
  try {
    return await pool.connect();
  } catch (err) {
    logger.warn({ err }, "no connection to the source for a query");
    // A pool with every connection in use is busy, not broken: it is kept.
    if (isPoolExhausted(err)) throw sourceBusy();
    throw new SourceUnreachableError();
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

// pg keeps these on every connected client; its types omit them.
interface ClientInternals {
  processID: number;
  secretKey: number;
  connection: { stream: { destroy(): void } };
}

/** Where the pool connects: the address that passed the network rules when it was opened. */
const cancelTargetOf = (pool: Pool): CancelTarget => ({
  host: String(pool.options.host),
  port: Number(pool.options.port ?? 5432),
});

/**
 * Runs a compiled plan on its own client inside a read-only transaction that
 * is always rolled back, reading the result through a cursor so no more than
 * one batch is held beyond the rows kept. Asks for one row past `maxRows` to
 * tell whether more exist.
 *
 * The run ends by `timeoutMs` three ways: the server's statement timeout, a
 * deadline of its own that cancels the statement on the server, and the
 * client's read timeout `CLIENT_GRACE_MS` later. An aborted `signal` cancels
 * the same way. A cancel goes on a connection of its own, never one of the
 * pool's; when it is not confirmed, or the statement outlives it by
 * `STOP_GRACE_MS`, the client's connection is cut and the client destroyed.
 * Every wait on the cursor also ends when the connection is lost, and a
 * client whose protocol state is unknown is destroyed, never released.
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
  const internals = client as unknown as ClientInternals;
  let broken: unknown;
  /** Set once the run is over and the client is about to be released or destroyed. */
  let finished = false;

  // pg-cursor ignores an error once it has sent Close and Sync, and then
  // waits for a ReadyForQuery that a dropped connection never sends; so every
  // step that waits on the cursor also settles when the connection is lost.
  let loseConnection!: (err: Error) => void;
  const lost = new Promise<never>((_, reject) => {
    loseConnection = reject;
  });
  lost.catch(() => undefined);
  const guard = <T>(step: Promise<T>): Promise<T> => Promise.race([step, lost]);
  // A checked-out client that loses its connection emits `error`; unheard,
  // it would crash the process.
  const onClientError = (err: Error) => {
    broken ??= err;
    loseConnection(err);
  };
  const onClientEnd = () => {
    if (finished) return;
    const err = new Error("Connection terminated unexpectedly");
    broken ??= err;
    loseConnection(err);
  };
  client.on("error", onClientError);
  client.on("end", onClientEnd);

  /** From the cursor's submission to the end of the run. */
  let active = false;
  let timedOut = false;
  let stopping: Promise<void> | undefined;
  let cutTimer: NodeJS.Timeout | undefined;
  const cut = () => {
    if (finished) return;
    const err = new Error("Connection terminated");
    broken ??= err;
    internals.connection.stream.destroy();
    loseConnection(err);
  };
  const stop = () => {
    if (!active || finished || stopping) return;
    stopping = sendCancelRequest(
      cancelTargetOf(pool),
      internals.processID,
      internals.secretKey
    ).then((confirmed) => {
      // A cancel sent but not confirmed may still land later, on whatever
      // the backend runs next: the client must never serve anyone again.
      if (!confirmed) {
        broken ??= new Error("cancel not confirmed");
        cut();
      } else {
        cutTimer = setTimeout(cut, STOP_GRACE_MS);
      }
    });
  };
  const onAbort = () => stop();
  signal?.addEventListener("abort", onAbort, { once: true });
  let deadline: NodeJS.Timeout | undefined;
  // A cancel that reaches the backend between two fetches is ignored, so the
  // read also stops itself after each batch.
  const checkStop = () => {
    signal?.throwIfAborted();
    if (timedOut) throw new QueryTimeoutError();
  };
  /** The cursor's portal is open and idle: the connection is mid-statement. */
  let cursorOpen = false;

  try {
    await client.query(sessionSetup(limits.timeoutMs));
    signal?.throwIfAborted();
    active = true;
    deadline = setTimeout(() => {
      timedOut = true;
      stop();
    }, limits.timeoutMs);
    const cursor = new Cursor<unknown[]>(sql, parameters, {
      rowMode: "array",
      types: RAW_TEXT,
    });
    // pg arms its read timeout from the submitted object's `query_timeout`,
    // read when it is submitted, before the pool's own; without it the
    // catalogue's shorter limit would apply.
    Object.assign(cursor, {
      query_timeout: limits.timeoutMs + CLIENT_GRACE_MS,
    });
    client.query(cursor);
    cursorOpen = true;
    // A failed read leaves no portal open: the driver ends the statement.
    cursor.once("error", () => {
      cursorOpen = false;
    });
    const read = await readRows(cursor, plan, limits, checkStop, guard);
    await guard(cursor.close());
    cursorOpen = false;
    return {
      columns: plan.columns.map(({ name, type }) => ({ name, type })),
      ...read,
    };
  } catch (err) {
    // Left mid-read, the statement is still open on the connection: it is
    // dropped rather than closed and waited for.
    if (cursorOpen) broken ??= err;
    // A client that timed out on its side is still busy with the statement;
    // one whose connection failed is gone.
    if (isClientReadTimeout(err) || isConnectionFailure(err)) broken ??= err;
    if (signal?.aborted) throw signal.reason;
    if (timedOut && !(err instanceof AppError)) {
      logger.info({ err }, "source query stopped at its deadline");
      throw new QueryTimeoutError();
    }
    throw callerError(err);
  } finally {
    finished = true;
    clearTimeout(deadline);
    signal?.removeEventListener("abort", onAbort);
    // The cancel must land while this client is still ours: once released,
    // its backend may be running someone else's statement.
    await stopping;
    clearTimeout(cutTimer);
    await finish(client, broken);
    client.off("error", onClientError);
    client.off("end", onClientEnd);
  }
};
