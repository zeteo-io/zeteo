import { mssqlDialect, type MssqlParameter } from "../sql/dialects/mssql.js";
import { invalidValue } from "../../engine/errors.js";
import { logger } from "../../utils/logger.js";
import type { SqlPlan } from "../sql/types.js";
import { compileSql } from "../sql/compile.js";
import { performance } from "node:perf_hooks";
import type { ConnectionPool } from "mssql";
import sql from "mssql";
import {
  AppError,
  QueryFailedError,
  QueryTimeoutError,
  sourceBusy,
  SourceUnreachableError,
} from "../../utils/errors.js";
import type {
  OpenLimits,
  PreparedQuery,
  QueryPlan,
  RowStream,
} from "../types.js";

/**
 * Whether the pool had no connection free in time. tarn's TimeoutError keeps
 * Error's `name`; its class is what tells it apart.
 */
export const isPoolExhausted = (err: unknown): boolean =>
  err instanceof Error && err.constructor.name === "TimeoutError";

/** How long past the run's deadline the driver's own request timeout waits before it cancels. */
const DRIVER_GRACE_MS = 2000;

/** The column metadata the driver gives in array row mode. */
interface ResultColumn {
  name: string;
  type?: { declaration?: string };
}

type Reader = (value: unknown) => unknown;

/**
 * The shortest decimal that reads back as the same 32-bit float, as Postgres
 * prints a `real`; the driver widens it to a double with digits of noise.
 */
const shortestFloat32 = (value: number): number => {
  for (let digits = 1; digits <= 9; digits++) {
    const shortest = Number(value.toPrecision(digits));
    if (Math.fround(shortest) === value) return shortest;
  }
  return value;
};

const asIs: Reader = (value) => value;
const instant: Reader = (value) => (value as Date).toISOString();

// Wire forms by the result column's declared type. The driver reads bigint
// as a string, bit as a boolean, and every date and time type as a Date in
// UTC (`useUTC`), cut, not rounded, at the millisecond. Decimal and money
// never arrive as such: the dialect returns them as text, which the driver
// could not read exactly. Any type not listed fails the run rather than
// travel in a form nobody chose.
const READERS: ReadonlyMap<string, Reader> = new Map([
  ["bit", asIs],
  ["tinyint", asIs],
  ["smallint", asIs],
  ["int", asIs],
  ["bigint", asIs],
  ["float", asIs],
  ["real", (value) => shortestFloat32(value as number)],
  ["date", (value) => (value as Date).toISOString().slice(0, 10)],
  ["datetime", instant],
  ["datetime2", instant],
  ["smalldatetime", instant],
  ["datetimeoffset", instant],
  ["char", asIs],
  ["varchar", asIs],
  ["nchar", asIs],
  ["nvarchar", asIs],
  ["text", asIs],
  ["ntext", asIs],
  ["xml", asIs],
  ["uniqueidentifier", asIs],
]);

const readerOf = (column: ResultColumn): Reader => {
  const declared = column.type?.declaration;
  const reader = declared === undefined ? undefined : READERS.get(declared);
  if (!reader) {
    logger.error(
      { column: column.name, type: declared },
      "a result column has a type with no wire form"
    );
    throw new QueryFailedError();
  }
  return reader;
};

/** Maps result columns to the plan's by position: the compiler aliases them c0, c1… */
const checkFields = (columns: ResultColumn[], plan: SqlPlan): void => {
  const expected = plan.columns.map((_, i) => `c${i}`);
  const names = columns.map((c) => c.name);
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

const parameterType = ({ type, value }: MssqlParameter) => {
  switch (type) {
    case "nvarchar":
      return typeof value === "string" && value.length > 4000
        ? sql.NVarChar(sql.MAX)
        : sql.NVarChar(4000);
    case "bigint":
      return sql.BigInt;
    case "bit":
      return sql.Bit;
    case "float":
      return sql.Float;
  }
};

// The driver's codes for a connection that is gone or never came: the
// socket failed, the connection closed, or the pool could not make one.
const CONNECTION_CODES = new Set([
  "ESOCKET",
  "ECONNCLOSED",
  "ECONNRESET",
  "ENOTOPEN",
  "ENOCONN",
  "ELOGIN",
  "EINSTLOOKUP",
]);
// Conversion errors a bound value the planner accepted still raises when the
// server converts it: 241 (a date or time from text), 242 (out of a date
// type's range), 8169 (a uniqueidentifier from text), 8114 (a type from
// nvarchar: a timestamp that leaves its type's range in UTC). Numbers bind
// in types every numeric column compares with, so none overflows.
const VALUE_ERRORS = new Set([241, 242, 8169, 8114]);
/** Errors of this severity end the session on the server: KILL, a crash, a shutdown. */
const SESSION_FATAL_SEVERITY = 20;

interface DriverError {
  code?: string;
  number?: number;
  class?: number;
  originalError?: { code?: string };
}

const isConnectionFailure = (err: unknown): boolean => {
  if (err instanceof sql.ConnectionError) return true;
  const e = (err ?? {}) as DriverError;
  return (
    CONNECTION_CODES.has(e.code ?? "") ||
    CONNECTION_CODES.has(e.originalError?.code ?? "") ||
    (e.class ?? 0) >= SESSION_FATAL_SEVERITY
  );
};

/** A driver error as the caller's; the driver's text goes only to the log. */
const callerError = (err: unknown): AppError => {
  if (err instanceof AppError) return err;
  const e = (err ?? {}) as DriverError;
  // The pool had no connection free in time: busy, not broken.
  if (isPoolExhausted(err)) {
    logger.warn({ err }, "no connection to the source for a query");
    return sourceBusy();
  }
  // A request that ran past the driver's timeout. Its cancel going
  // unacknowledged, which closes the connection, comes the same way: a
  // request error wrapping the connection's ETIMEOUT. The caller's query
  // timed out either way. A ConnectionError proper is the pool failing to
  // log in in time: the source is unreachable.
  if (e.code === "ETIMEOUT" && !(err instanceof sql.ConnectionError)) {
    logger.warn({ err }, "source query outlived its deadline in the driver");
    return new QueryTimeoutError();
  }
  if (isConnectionFailure(err)) {
    logger.warn({ err }, "source connection failed during a query");
    return new SourceUnreachableError();
  }
  if (e.code === "EREQUEST" && VALUE_ERRORS.has(e.number ?? 0)) {
    logger.info({ err }, "the source could not convert a query's value");
    return invalidValue();
  }
  logger.warn({ err }, "source query failed");
  return new QueryFailedError();
};

/** A plan compiled to SQL Server SQL with its typed parameters. */
export class AzureSqlPreparedQuery implements PreparedQuery {
  constructor(
    readonly plan: SqlPlan,
    readonly sql: string,
    readonly parameters: MssqlParameter[]
  ) {}
}

/** Compiles a plan of the SQL language for SQL Server; throws `QueryError` `too_many_parameters`. */
export const prepareAzureSqlQuery = (
  plan: QueryPlan,
  rows: { limit: number; offset: number }
): AzureSqlPreparedQuery => {
  // The plan comes from this adapter's own language, so it is a SQL plan.
  const sqlPlan = plan as SqlPlan;
  const { sql: text, parameters } = compileSql(sqlPlan, mssqlDialect, rows);
  return new AzureSqlPreparedQuery(
    sqlPlan,
    text,
    parameters as MssqlParameter[]
  );
};

type Acquired = (err: unknown, connection?: unknown, config?: unknown) => void;

// What the driver keeps on a pool and a request but its types leave out: the
// pool's callback form of acquire, which a request calls on its parent, and
// the request's own overrides, read once it has its connection.
interface PoolInternals {
  acquire(requester: unknown, callback: Acquired): unknown;
  release(connection: unknown): unknown;
}
interface RequestInternals {
  overrides: { requestTimeout?: number };
}

/**
 * The pool as one request's parent, so the request's time is measured once
 * it has a connection: with none left by `deadlineAt` the connection goes
 * back and the request fails before anything is sent; otherwise the driver's
 * request timeout is the time left plus `DRIVER_GRACE_MS`. Everything else
 * is the pool's own, through the prototype.
 */
const deadlineParent = (
  pool: ConnectionPool,
  deadlineAt: number
): ConnectionPool => {
  const own = pool as unknown as PoolInternals;
  const parent = Object.create(pool) as PoolInternals;
  parent.acquire = (requester, callback) =>
    own.acquire(requester, (err, connection, config) => {
      if (err) return callback(err);
      const timeLeft = deadlineAt - performance.now();
      if (timeLeft <= 0) {
        own.release(connection);
        return callback(new QueryTimeoutError());
      }
      (requester as RequestInternals).overrides.requestTimeout =
        Math.ceil(timeLeft) + DRIVER_GRACE_MS;
      callback(null, connection, config);
    });
  return parent as unknown as ConnectionPool;
};

/** Rows queued above this many pause the request until the reader catches up. */
export const HIGH_WATER_ROWS = 500;
/** A paused request resumes once fewer rows than this are queued. */
export const LOW_WATER_ROWS = 100;

/** Why the run was stopped on this side. */
type Stop = "timeout" | "abort" | "fault" | "close";

const closedError = () => new Error("the row stream is closed");

/**
 * Opens a prepared query as one request on the pool: the compiled SELECT
 * only, its parameters bound with the types the dialect chose. It resolves
 * once the result's columns are known and checked against the plan; the
 * request stays in stream mode, its rows normalised and queued as the driver
 * parses them. Above `HIGH_WATER_ROWS` queued the request is paused, so the
 * server waits on the connection, and it resumes below `LOW_WATER_ROWS`.
 * `next` hands out queued rows, waiting for one when none is queued.
 *
 * The run ends by `deadlineAt`, however long it waited for a connection: a
 * deadline of its own cancels the request, before or after it has one; a
 * request whose time is up once it has a connection sends nothing; and the
 * driver's request timeout, the time left then plus `DRIVER_GRACE_MS`, is
 * the backstop. An aborted `signal` cancels the same way, and so does
 * `close` before the result has ended. A cancel is an attention on the
 * request's own connection, so it never waits for another, and the driver
 * reads a paused request on to the acknowledgement. Every failure, and
 * `close`, settles only once the driver has finished with the request: by
 * the server's acknowledgement (the connection goes back to the pool clean)
 * or by closing the connection when none comes within the driver's
 * `cancelTimeout` (the pool then discards it). Once the run is stopped, what
 * the driver reports changes nothing. SQL Server has no read-only
 * transaction: the compiled statement is a single SELECT, and the login is
 * checked for write rights when the source is registered.
 */
export const openAzureSqlQuery = async (
  pool: ConnectionPool,
  prepared: AzureSqlPreparedQuery,
  limits: OpenLimits,
  signal?: AbortSignal
): Promise<RowStream> => {
  if (!Number.isFinite(limits.deadlineAt)) {
    throw new Error(`invalid query deadline: ${limits.deadlineAt}`);
  }
  signal?.throwIfAborted();
  const { plan, sql: text, parameters } = prepared;

  const request = new sql.Request(deadlineParent(pool, limits.deadlineAt));
  request.stream = true;
  request.arrayRowMode = true;
  try {
    parameters.forEach((p, i) => {
      request.input(String(i + 1), parameterType(p), p.value);
    });
  } catch (err) {
    logger.warn({ err }, "a query parameter could not be bound");
    throw new QueryFailedError();
  }

  /** Normalised rows not yet handed out. */
  let queue: unknown[][] = [];
  let paused = false;
  let readers: Reader[] | undefined;
  let stop: Stop | undefined;
  /** Why the run failed on this side: columns or values it could not take. */
  let fault: AppError | undefined;
  /** The driver's first error before the run was stopped. */
  let driverError: unknown;
  /** The driver has finished with the request and given its connection back. */
  let settled = false;
  /** What the run ended with when the driver finished, if it failed. */
  let endError: unknown;
  /** What every read rejects with once one has rejected. */
  let failure: unknown;
  let reading: Promise<unknown[][]> | undefined;
  let closing: Promise<void> | undefined;

  // Whoever waits for the run to change: the opening for its columns, a
  // read for rows, `close` for the driver to finish.
  let waiting: (() => void)[] = [];
  const changed = () => {
    const woken = waiting;
    waiting = [];
    for (const wake of woken) wake();
  };
  const nextChange = () =>
    new Promise<void>((resolve) => {
      waiting.push(resolve);
    });

  const stopError = (reason: Stop): unknown => {
    switch (reason) {
      case "abort":
        return signal!.reason;
      case "timeout":
        logger.info("source query stopped at its deadline");
        return new QueryTimeoutError();
      case "close":
        return closedError();
      case "fault":
        return fault;
    }
  };

  const halt = (reason: Stop) => {
    // A run that has already failed stays as it failed.
    if (stop || endError !== undefined) return;
    stop = reason;
    if (!settled) request.cancel();
    changed();
  };
  const refuse = (err: unknown) => {
    fault = err instanceof AppError ? err : new QueryFailedError();
    if (!(err instanceof AppError)) {
      logger.error({ err }, "a result could not be read");
    }
    halt("fault");
  };

  request.on("recordset", (columns: ResultColumn[]) => {
    if (stop) return;
    try {
      if (readers) {
        logger.error("the query returned more than one result");
        throw new QueryFailedError();
      }
      checkFields(columns, plan);
      readers = columns.map(readerOf);
      changed();
    } catch (err) {
      refuse(err);
    }
  });

  request.on("row", (raw: unknown[]) => {
    if (stop || driverError !== undefined) return;
    try {
      if (!readers) throw new Error("a row before its columns");
      queue.push(
        raw.map((value, i) => (value === null ? null : readers![i]!(value)))
      );
      if (queue.length > HIGH_WATER_ROWS && !paused) {
        paused = true;
        request.pause();
      }
      changed();
    } catch (err) {
      refuse(err);
    }
  });

  // Once the run is stopped, what the driver reports (the cancel itself, or
  // a failure while it drains) changes nothing.
  request.on("error", (err: unknown) => {
    if (stop) {
      logger.debug({ err }, "source request ended after the run stopped");
      return;
    }
    driverError ??= err;
    changed();
  });

  const deadline = setTimeout(
    () => halt("timeout"),
    Math.max(0, limits.deadlineAt - performance.now())
  );
  const onAbort = () => halt("abort");
  signal?.addEventListener("abort", onAbort, { once: true });
  const release = () => {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", onAbort);
  };

  // In stream mode the callback comes once the driver is done with the
  // request and has released its connection; errors come as events.
  request.query(text, () => {
    settled = true;
    if (stop) endError = stopError(stop);
    // A run whose time ran out while it waited for a connection timed out,
    // however the pool reports it.
    else if (
      isPoolExhausted(driverError) &&
      performance.now() >= limits.deadlineAt
    ) {
      endError = new QueryTimeoutError();
    } else if (driverError !== undefined) endError = callerError(driverError);
    else if (!readers) {
      logger.error("the query returned no result");
      endError = new QueryFailedError();
    }
    changed();
  });

  const take = (maxRows: number): unknown[][] => {
    const rows = queue.length <= maxRows ? queue : queue.slice(0, maxRows);
    queue = rows === queue ? [] : queue.slice(maxRows);
    if (paused && queue.length < LOW_WATER_ROWS && !stop) {
      paused = false;
      request.resume();
    }
    return rows;
  };

  const read = async (maxRows: number): Promise<unknown[][]> => {
    for (;;) {
      if (settled) {
        const err = endError ?? (stop && stopError(stop));
        if (err !== undefined) throw err;
        return queue.length > 0 ? take(maxRows) : [];
      }
      // A stopped or failing run hands out nothing more; it fails once the
      // driver is done with it.
      if (!stop && driverError === undefined && queue.length > 0) {
        return take(maxRows);
      }
      await nextChange();
    }
  };

  const next = (maxRows: number): Promise<unknown[][]> => {
    if (failure !== undefined) return Promise.reject(failure);
    if (closing) return Promise.reject(closedError());
    if (reading) {
      return Promise.reject(new Error("a read is already in progress"));
    }
    if (!Number.isInteger(maxRows) || maxRows < 1) {
      return Promise.reject(new Error(`invalid batch size: ${maxRows}`));
    }
    reading = read(maxRows).catch((err: unknown) => {
      failure = err;
      throw err;
    });
    return reading.finally(() => {
      reading = undefined;
    });
  };

  const close = (): Promise<void> =>
    (closing ??= (async () => {
      halt("close");
      while (!settled) await nextChange();
      await reading?.catch(() => undefined);
      release();
    })().catch((err: unknown) => {
      logger.error({ err }, "closing a source query failed");
    }));

  // Open once the columns are known, or fail once the driver is done.
  while (!readers || stop) {
    if (settled) {
      release();
      throw endError ?? new QueryFailedError();
    }
    await nextChange();
  }

  return {
    columns: plan.columns.map(({ name, type }) => ({ name, type })),
    next,
    close,
  };
};
