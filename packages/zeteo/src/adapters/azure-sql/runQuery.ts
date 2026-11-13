import { mssqlDialect, type MssqlParameter } from "../sql/dialects/mssql.js";
import type { QueryResult, RunLimits } from "../types.js";
import { invalidValue } from "../../engine/errors.js";
import { logger } from "../../utils/logger.js";
import type { SqlPlan } from "../sql/types.js";
import { compileSql } from "../sql/compile.js";
import type { ConnectionPool } from "mssql";
import sql from "mssql";
import {
  AppError,
  QueryFailedError,
  QueryTimeoutError,
  sourceBusy,
  SourceUnreachableError,
} from "../../utils/errors.js";

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
// Conversion and overflow errors a bound value raises when the server
// converts it to the column's type: 241 (date or time from text), 242 (out of
// a date type's range), 8169 (uniqueidentifier from text), 8114 (a type from
// nvarchar), 8115 (arithmetic overflow), 245 (text to a number), 220 (an
// integer type's range), 517 (date arithmetic overflow).
const VALUE_ERRORS = new Set([241, 242, 8169, 8114, 8115, 245, 220, 517]);
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

type Stop = "cap" | "timeout" | "abort" | "fault";

// The driver takes a request's own timeout, over the pool's, as a second
// constructor argument that its types leave out.
const RequestWithTimeout = sql.Request as unknown as new (
  pool: ConnectionPool,
  overrides: { requestTimeout: number }
) => sql.Request;

/**
 * Runs a compiled plan as one request on the pool: the compiled SELECT only,
 * its parameters bound with the types the dialect chose. Rows are read as
 * the driver parses them and normalised one by one; asks for one row past
 * `maxRows` to tell whether more exist, and at either cap cancels the
 * request, so the rest of the result is never read.
 *
 * The run ends by `timeoutMs` with a deadline of its own that cancels the
 * request, and the driver's request timeout `DRIVER_GRACE_MS` later as a
 * backstop. An aborted `signal` cancels the same way. A cancel is an
 * attention on the request's own connection, so it never waits for another;
 * the run settles only once the driver has finished with the request, by
 * the server's acknowledgement (the connection goes back to the pool clean)
 * or by closing the connection when none comes within the driver's
 * `cancelTimeout` (the pool then discards it). SQL Server has no read-only
 * transaction: the compiled statement is a single SELECT, and the login is
 * checked for write rights when the source is registered.
 */
export const runAzureSqlQuery = async (
  pool: ConnectionPool,
  plan: SqlPlan,
  limits: RunLimits,
  signal?: AbortSignal
): Promise<QueryResult> => {
  if (!Number.isSafeInteger(limits.timeoutMs) || limits.timeoutMs <= 0) {
    return Promise.reject(
      new Error(`invalid query timeout: ${limits.timeoutMs}`)
    );
  }
  if (signal?.aborted) return Promise.reject(signal.reason);
  const { sql: text, parameters } = compileSql(plan, mssqlDialect, {
    limit: limits.maxRows + 1,
    offset: plan.offset,
  });

  const request = new RequestWithTimeout(pool, {
    requestTimeout: limits.timeoutMs + DRIVER_GRACE_MS,
  });
  request.stream = true;
  request.arrayRowMode = true;
  try {
    (parameters as MssqlParameter[]).forEach((p, i) => {
      request.input(String(i + 1), parameterType(p), p.value);
    });
  } catch (err) {
    logger.warn({ err }, "a query parameter could not be bound");
    return Promise.reject(new QueryFailedError());
  }

  return new Promise<QueryResult>((resolve, reject) => {
    const rows: unknown[][] = [];
    let readers: Reader[] | undefined;
    let bytes = 0;
    let truncated: QueryResult["truncated"] = false;
    let stop: Stop | undefined;
    /** Why the run failed on this side: columns or values it could not take. */
    let fault: AppError | undefined;
    /** The driver's first error before the run was stopped. */
    let failure: unknown;

    const halt = (reason: Stop) => {
      if (stop) return;
      stop = reason;
      request.cancel();
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
      } catch (err) {
        refuse(err);
      }
    });

    request.on("row", (raw: unknown[]) => {
      if (stop) return;
      try {
        if (!readers) throw new Error("a row before its columns");
        if (rows.length === limits.maxRows) {
          truncated = "rows";
          halt("cap");
          return;
        }
        const row = raw.map((value, i) =>
          value === null ? null : readers![i]!(value)
        );
        bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
        if (bytes > limits.maxBytes) {
          truncated = "bytes";
          halt("cap");
          return;
        }
        rows.push(row);
      } catch (err) {
        refuse(err);
      }
    });

    // Once the run is stopped, what the driver reports (the cancel itself,
    // or a failure while it drains) changes nothing.
    request.on("error", (err: unknown) => {
      if (stop) {
        logger.debug({ err }, "source request ended after the run stopped");
        return;
      }
      failure ??= err;
    });

    const deadline = setTimeout(() => halt("timeout"), limits.timeoutMs);
    const onAbort = () => halt("abort");
    signal?.addEventListener("abort", onAbort, { once: true });

    const settle = () => {
      clearTimeout(deadline);
      signal?.removeEventListener("abort", onAbort);
      if (stop === "abort") return reject(signal!.reason);
      if (stop === "timeout") {
        logger.info("source query stopped at its deadline");
        return reject(new QueryTimeoutError());
      }
      if (fault) return reject(fault);
      if (failure !== undefined) return reject(callerError(failure));
      if (!readers) {
        logger.error("the query returned no result");
        return reject(new QueryFailedError());
      }
      resolve({
        columns: plan.columns.map(({ name, type }) => ({ name, type })),
        rows,
        truncated,
      });
    };

    // In stream mode the callback comes once the driver is done with the
    // request and has released its connection; errors come as events.
    request.query(text, settle);
  });
};
