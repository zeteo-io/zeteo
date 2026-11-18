import { Response, Request, NextFunction } from "express";
import { HttpError } from "@tereo-io/sdk";
import { logger } from "./logger.js";
import { ZodError } from "zod";
import {
  errorChain,
  isForeignKeyConstraintError,
  isUniqueConstraintError,
  pgErrorCodes,
} from "./prismaErrors.js";

export interface AppErrorOptions {
  /** Extra response body fields, after `error` and `error_description`. */
  details?: Record<string, unknown>;
  /** Response headers, e.g. `Retry-After`. */
  headers?: Record<string, string | number>;
}

export class AppError extends Error {
  public details?: Record<string, unknown>;
  public headers?: Record<string, string | number>;

  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    options: AppErrorOptions = {}
  ) {
    super(message);
    this.name = "AppError";
    this.details = options.details;
    this.headers = options.headers;
  }
}

/** One failed check: `path` is the field, dotted (`grants.0.permission`), "" for the whole value. */
export interface ValidationIssue {
  path: string;
  message: string;
}

/** The most issues an error lists; a 400's `error_description` says how many it left out. */
export const MAX_ISSUES = 20;
/** The most characters of an issue's path or message: a path holds the request's own keys. */
export const MAX_ISSUE_CHARS = 256;

export const truncate = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** The first `MAX_ISSUES` of the error's issues, each cut to `MAX_ISSUE_CHARS`. */
export const issuesOf = (error: ZodError): ValidationIssue[] =>
  error.issues.slice(0, MAX_ISSUES).map((i) => ({
    path: truncate(i.path.join("."), MAX_ISSUE_CHARS),
    message: truncate(i.message, MAX_ISSUE_CHARS),
  }));

export class ValidationError extends AppError {
  constructor(message: string, issues?: ValidationIssue[]) {
    super(400, "invalid_request", message, {
      details: issues ? { issues } : undefined,
    });
    this.name = "ValidationError";
  }
}

export class BadRequestError extends AppError {
  constructor(code: string, message: string) {
    super(400, code, message);
    this.name = "BadRequestError";
  }
}

/**
 * A dashboard panel whose settings do not fit the caller's own saved query,
 * saved panel or chart: `problems` name each setting at fault and why (never
 * a column or anything of the catalogue).
 */
export class InvalidPanelError extends AppError {
  constructor(
    message: string,
    problems: Array<{ setting: string; problem: string }>
  ) {
    super(400, "invalid_panel", message, { details: { problems } });
    this.name = "InvalidPanelError";
  }
}

export class UnauthorizedError extends AppError {
  constructor(
    message = "Unauthorized",
    code = "unauthorized",
    options: AppErrorOptions = {}
  ) {
    super(401, code, message, options);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super(403, "forbidden", message);
    this.name = "ForbiddenError";
  }
}

/** An export from a source whose exports are off, or capped at no rows. */
export class ExportNotEnabledError extends AppError {
  constructor() {
    super(403, "export_not_enabled", "Exports are not enabled for this source");
    this.name = "ExportNotEnabledError";
  }
}

/**
 * A saved query the caller may not use. Every cause (a grant missing, a
 * relation not visible, the source archived or not granted, a column gone
 * missing) answers this one error, with no details, so none can be told apart.
 */
export class SavedQueryNotAccessibleError extends AppError {
  constructor() {
    super(
      403,
      "saved_query_not_accessible",
      "You need expanded permissions to run this saved query. Ask an admin to extend your access."
    );
    this.name = "SavedQueryNotAccessibleError";
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super(404, "not_found", message);
    this.name = "NotFoundError";
  }
}

/**
 * A source host the deploy does not permit. The message never says which rule
 * failed or whether the address is in a range that is always refused; the log
 * has the detail.
 */
export class HostNotAllowedError extends AppError {
  constructor() {
    super(422, "host_not_allowed", "The host is not permitted");
    this.name = "HostNotAllowedError";
  }
}

/**
 * A source that could not be connected to, or that refused the login. The
 * message is fixed: the driver's error goes to the log, never to the caller.
 */
export class SourceUnreachableError extends AppError {
  constructor() {
    super(
      502,
      "source_unreachable",
      "The source could not be reached or refused the login"
    );
    this.name = "SourceUnreachableError";
  }
}

/**
 * Tereo, which names the users and groups, could not be asked. The message is
 * fixed: what went wrong goes to the log, never to the caller.
 */
export class TereoUnreachableError extends AppError {
  constructor() {
    super(502, "tereo_unreachable", "Tereo could not be reached");
    this.name = "TereoUnreachableError";
  }
}

/** A query that ran past its time limit on the source; it was cancelled there. */
export class QueryTimeoutError extends AppError {
  constructor() {
    super(504, "query_timeout", "The query ran past its time limit");
    this.name = "QueryTimeoutError";
  }
}

/**
 * A query the source refused or failed to run. The message is fixed: the
 * database's error goes to the log, never to the caller.
 */
export class QueryFailedError extends AppError {
  constructor() {
    super(502, "query_failed", "The source could not run the query");
    this.name = "QueryFailedError";
  }
}

/** The most login-check findings a response lists. */
export const MAX_FINDINGS = 20;

/**
 * Login-check findings as a response carries them: the first `MAX_FINDINGS`,
 * with `truncated: true` when there were more.
 */
export const findingsBody = <F extends { code: string; detail: string }>(
  findings: F[]
): { findings: F[]; truncated?: true } => ({
  findings: findings.slice(0, MAX_FINDINGS),
  ...(findings.length > MAX_FINDINGS && { truncated: true as const }),
});

/**
 * A login that can change data or reach beyond the database, found by the
 * login check. The body lists the findings (code and detail).
 */
export class WritableLoginError extends AppError {
  constructor(findings: Array<{ code: string; detail: string }>) {
    super(
      422,
      "writable_login",
      "The login can write or reach beyond the database; use a read-only login or set allow_writable_login",
      { details: findingsBody(findings) }
    );
    this.name = "WritableLoginError";
  }
}

/** A change to a source that has been archived. */
export class SourceArchivedError extends AppError {
  constructor() {
    super(409, "source_archived", "The source is archived");
    this.name = "SourceArchivedError";
  }
}

/**
 * A change, test or refresh of a file source through the database sources'
 * routes: its settings, data and catalogue are managed by its uploads.
 */
export class FileSourceManagedElsewhereError extends AppError {
  constructor() {
    super(
      409,
      "file_source_managed_elsewhere",
      "A file source is managed through its uploads, not here"
    );
    this.name = "FileSourceManagedElsewhereError";
  }
}

/** File Sources are off: `FILE_SOURCES_READER_URL` is not set. */
export class FileSourcesNotConfiguredError extends AppError {
  constructor() {
    super(404, "file_sources_not_configured", "File Sources are not enabled");
    this.name = "FileSourcesNotConfiguredError";
  }
}

/** An upload over `FILE_SOURCE_MAX_BYTES`. */
export class FileTooLargeError extends AppError {
  constructor(maxBytes: number) {
    super(413, "file_too_large", `The file is larger than ${maxBytes} bytes`, {
      details: { max_bytes: maxBytes },
    });
    this.name = "FileTooLargeError";
  }
}

/** An upload that is neither a CSV nor an xlsx workbook, judged by its content. */
export class UnsupportedFileTypeError extends AppError {
  constructor() {
    super(
      415,
      "unsupported_file_type",
      "Only CSV and xlsx files can be uploaded"
    );
    this.name = "UnsupportedFileTypeError";
  }
}

/** A file that cannot be read: `code` is the parser's (`unsupported_encoding`, `row_too_long`...), `row` the 1-based row at fault. */
export class FileUnreadableError extends AppError {
  constructor(code: string, message: string, row?: number) {
    super(422, code, message, {
      details: row === undefined ? undefined : { row },
    });
    this.name = "FileUnreadableError";
  }
}

/** An upload that holds no table with a column. */
export class EmptyFileError extends AppError {
  constructor() {
    super(422, "empty_file", "The file has no data");
    this.name = "EmptyFileError";
  }
}

/** A staging that does not exist, has expired or is another user's: one answer for all. */
export class StagingNotFoundError extends AppError {
  constructor() {
    super(404, "staging_not_found", "Upload not found or expired");
    this.name = "StagingNotFoundError";
  }
}

/** A declared relation the catalogue cannot hold; the message says which check failed. */
export class InvalidRelationError extends AppError {
  constructor(message: string) {
    super(422, "invalid_relation", message);
    this.name = "InvalidRelationError";
  }
}

/** A grant the catalogue cannot hold, such as a column that is not on the grant's table. */
export class InvalidGrantError extends AppError {
  constructor(message: string) {
    super(422, "invalid_grant", message);
    this.name = "InvalidGrantError";
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code = "conflict") {
    super(409, code, message);
    this.name = "ConflictError";
  }
}

/**
 * Every rate-limit refusal, `too_many_requests` unless a narrower code says
 * which limit, with the seconds to wait in both the `Retry-After` header and
 * the body's `retry_after`.
 */
export class TooManyRequestsError extends AppError {
  constructor(
    public retryAfter: number,
    message = "Rate limit exceeded. Please try again later.",
    code = "too_many_requests"
  ) {
    super(429, code, message, {
      details: { retry_after: retryAfter },
      headers: { "Retry-After": retryAfter },
    });
    this.name = "TooManyRequestsError";
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message: string, retryAfter?: number) {
    super(503, "temporarily_unavailable", message, {
      headers:
        retryAfter === undefined ? undefined : { "Retry-After": retryAfter },
    });
    this.name = "ServiceUnavailableError";
  }
}

const BUSY_RETRY_AFTER_SECONDS = 1;

/** A source whose pool had no connection free in time: busy, not broken, so the pool is kept. */
export const sourceBusy = (): ServiceUnavailableError =>
  new ServiceUnavailableError(
    "The source is busy; retry the request shortly",
    BUSY_RETRY_AFTER_SECONDS
  );

// pg-pool's errors carry no code: the first for a connection it could not hand
// out in time, the second for a new one whose connect ran past the timeout.
const CONNECT_TIMEOUT_MESSAGES = [
  "timeout exceeded when trying to connect",
  "Connection terminated due to connection timeout",
];

// P2028: a transaction that could not start, or expired. 55P03: a lock wait
// past `lock_timeout`. 53300 (P2037 through Prisma): too many connections.
// 57P03: the server is starting up or shutting down.
const BUSY_CODES = ["P2028", "55P03", "53300", "P2037", "57P03"];

/**
 * The database was too busy, not wrong. Each case rolled back or never reached
 * the database, so the request can be retried.
 */
export const isDatabaseBusy = (err: unknown): boolean =>
  pgErrorCodes(err).some((code) => BUSY_CODES.includes(code)) ||
  errorChain(err).some(
    (e) =>
      typeof e.message === "string" &&
      CONNECT_TIMEOUT_MESSAGES.includes(e.message)
  );

// Prisma's P2034 from its own queries; 40P01 (deadlock) and 40001
// (serialization failure) through the adapter, wrapped in P2010 for raw SQL.
const CONFLICT_CODES = ["P2034", "40P01", "40001"];

// The only codes a library's HTTP-shaped error answers with, each under its
// own status: tereo's auth middleware throws these.
const LIBRARY_ERROR_STATUS: Record<string, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
};

/**
 * The SDK auth middleware's 401, 403 or 404 (`HttpError`), meant for the client. A tereo
 * `RequestError` never is: it is a failed call to tereo, and its code and message are the SDK's.
 */
const isClientFacingLibraryError = (err: unknown): err is HttpError =>
  err instanceof HttpError &&
  Object.hasOwn(LIBRARY_ERROR_STATUS, err.code) &&
  LIBRARY_ERROR_STATUS[err.code] === err.statusCode;

/**
 * A body-parser (`express.json` / `express.urlencoded`) rejection: an
 * http-errors 4xx with a string `type` such as `entity.parse.failed` or
 * `entity.too.large`, but no `code`. All but a body too large answer 400, an
 * unsupported charset or encoding (body-parser's 415) included.
 */
const bodyParserError = (
  err: unknown
): { status: number; code: string; message: string } | null => {
  const { status, type, expose } = (err ?? {}) as {
    status?: unknown;
    type?: unknown;
    expose?: unknown;
  };
  if (
    typeof type !== "string" ||
    !Number.isInteger(status) ||
    (status as number) < 400 ||
    (status as number) > 499
  ) {
    return null;
  }
  if (type === "entity.parse.failed") {
    return {
      status: 400,
      code: "invalid_request",
      message: "Request body is malformed",
    };
  }
  if (type === "entity.too.large") {
    return {
      status: 413,
      code: "payload_too_large",
      message: "Request body is too large",
    };
  }
  return {
    status: 400,
    code: "invalid_request",
    message:
      expose === true && err instanceof Error
        ? err.message
        : "Request body could not be read",
  };
};

interface ErrorResponse {
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  headers?: Record<string, string | number>;
}

const errorResponse = (err: Error): ErrorResponse => {
  const bodyError = bodyParserError(err);
  if (bodyError) return bodyError;

  if (err instanceof ZodError) {
    // RFC 6749 Section 5.2: invalid_request for malformed requests
    return {
      status: 400,
      code: "invalid_request",
      message: err.issues
        .map((e) => `${e.path.join(".")}: ${e.message}`)
        .join(", "),
      details: { issues: issuesOf(err) },
    };
  }

  if (err instanceof AppError) {
    return {
      status: err.statusCode,
      code: err.code,
      message: err.message,
      details: err.details,
      headers: err.headers,
    };
  }

  if (isClientFacingLibraryError(err)) {
    return { status: err.statusCode, code: err.code, message: err.message };
  }

  if (isDatabaseBusy(err)) {
    const unavailable = new ServiceUnavailableError(
      "The service is busy; retry the request shortly",
      BUSY_RETRY_AFTER_SECONDS
    );
    return {
      status: unavailable.statusCode,
      code: unavailable.code,
      message: unavailable.message,
      headers: unavailable.headers,
    };
  }

  // Retryable, so 409 lets clients back off and retry.
  if (pgErrorCodes(err).some((code) => CONFLICT_CODES.includes(code))) {
    return {
      status: 409,
      code: "version_conflict",
      message:
        "Concurrent update conflict; retry the request after re-reading state",
    };
  }

  // An update or delete whose row was not there (P2025) that no caller
  // mapped: the row is gone, typically deleted since the request read it.
  if ((err as { code?: unknown }).code === "P2025") {
    return { status: 404, code: "not_found", message: "Not found" };
  }

  // A unique violation that no caller mapped to a specific error — typically
  // two concurrent creates of the same name. Besides P2002 it arrives wrapped
  // in other codes or as the raw driver adapter error (see prismaErrors.ts).
  if (isUniqueConstraintError(err)) {
    return {
      status: 409,
      code: "conflict",
      message: "A resource with the same unique value already exists",
    };
  }

  // A foreign-key or RESTRICT violation no caller mapped: the row is still
  // referenced, or a row it references went away since the request read it.
  if (isForeignKeyConstraintError(err)) {
    return {
      status: 409,
      code: "conflict",
      message:
        "The change conflicts with a record this one references or is referenced by",
    };
  }

  return {
    status: 500,
    code: "server_error",
    message: "An unexpected error occurred",
  };
};

/**
 * Writes the body `{ error, error_description, ...details, request_id }`;
 * `request_id` is the request's `X-Request-ID`, left out only where no
 * request id middleware ran.
 */
const writeError = (
  res: Response,
  { status, code, message, details, headers }: ErrorResponse,
  requestId: string | undefined
): void => {
  if (res.headersSent) {
    // The status line is out: only a reset tells the client the body is cut.
    res.destroy();
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  for (const [name, value] of Object.entries(headers ?? {})) {
    res.setHeader(name, value);
  }
  res.status(status).json({
    error: code,
    error_description: message,
    ...details,
    ...(requestId !== undefined && { request_id: requestId }),
  });
};

/**
 * A Prisma validation error's message reprints the whole query, argument
 * values included. For logs it is cut to its first line, which names the
 * call, and the stack keeps its frames without the message.
 */
export const loggableError = (err: Error): Error => {
  if (err.name !== "PrismaClientValidationError") return err;
  const summary =
    err.message
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? "";
  const loggable = new Error(summary);
  loggable.name = err.name;
  const frames = (err.stack ?? "")
    .split("\n")
    .filter((line) => /^\s+at /.test(line));
  loggable.stack = [`${err.name}: ${summary}`, ...frames].join("\n");
  return loggable;
};

export const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void => {
  const response = errorResponse(err);
  const { status, code } = response;

  // The query string is left out.
  const context = {
    method: req.method,
    path: req.originalUrl?.split(/[?#]/, 1)[0],
    status,
  };
  const logged = loggableError(err);
  if (status >= 500) {
    logger.error({ ...context, err: logged }, logged.message);
  } else {
    logger.warn({ ...context, code, name: err.name }, logged.message);
  }

  writeError(res, response, req.requestId);
};
