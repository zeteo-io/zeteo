import { Response, Request, NextFunction } from "express";
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

export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super(404, "not_found", message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code = "conflict") {
    super(409, code, message);
    this.name = "ConflictError";
  }
}

/**
 * Every rate-limit refusal: `too_many_requests`, with the seconds to wait in
 * both the `Retry-After` header and the body's `retry_after`.
 */
export class TooManyRequestsError extends AppError {
  constructor(
    public retryAfter: number,
    message = "Rate limit exceeded. Please try again later."
  ) {
    super(429, "too_many_requests", message, {
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

const writeError = (
  res: Response,
  { status, code, message, details, headers }: ErrorResponse
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
  res
    .status(status)
    .json({ error: code, error_description: message, ...details });
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

  writeError(res, response);
};
