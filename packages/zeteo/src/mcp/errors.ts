import { getRequestId, withRequestId } from "../utils/requestId.js";
import { ToolError, type ToolContext } from "@tereo-io/mcp";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

/**
 * An `AppError` as a tool error whose text is the JSON zeteo's HTTP error
 * body would carry: `{ error, error_description, ...details, request_id }`.
 * One of 500 or above is logged at error here, as the package logs every tool
 * error at info. Anything else is rethrown, and the model sees only an
 * internal error naming the request.
 */
export const asToolError = (err: unknown, requestId: string): never => {
  if (!(err instanceof AppError)) throw err;
  if (err.statusCode >= 500) {
    logger.error({ err, request_id: requestId }, "MCP tool call failed");
  }
  throw new ToolError(
    JSON.stringify({
      error: err.code,
      error_description: err.message,
      ...err.details,
      request_id: requestId,
    })
  );
};

/**
 * Runs one tool call's work as zeteo's request `ctx.requestId`, so every
 * line zeteo logs for it carries the id the package logs and the model sees.
 * The HTTP request it came in on (its `X-Request-ID`) is logged beside it
 * once. Zeteo's errors become tool errors.
 */
export const inToolCall = <R>(
  ctx: ToolContext,
  work: () => Promise<R>
): Promise<R> => {
  const httpRequestId = getRequestId();
  return withRequestId(ctx.requestId, async () => {
    if (httpRequestId && httpRequestId !== ctx.requestId) {
      logger.info(
        { http_request_id: httpRequestId, request_id: ctx.requestId },
        "MCP tool call"
      );
    }
    try {
      return await work();
    } catch (err) {
      return asToolError(err, ctx.requestId);
    }
  });
};
