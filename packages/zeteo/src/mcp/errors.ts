import { AppError } from "../utils/errors.js";
import { ToolError } from "@tereo-io/mcp";

/**
 * An `AppError` as a tool error whose text is the JSON zeteo's HTTP error
 * body would carry: `{ error, error_description, ...details, request_id }`.
 * Anything else is rethrown, and the model sees only an internal error
 * naming the request.
 */
export const asToolError = (err: unknown, requestId: string): never => {
  if (!(err instanceof AppError)) throw err;
  throw new ToolError(
    JSON.stringify({
      error: err.code,
      error_description: err.message,
      ...err.details,
      request_id: requestId,
    })
  );
};
