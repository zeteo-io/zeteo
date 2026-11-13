// @module-tag unit
// @module-tag platform
import { getRequestId, withRequestId } from "../../utils/requestId.js";
import { asToolError, inToolCall } from "../../mcp/errors.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryError } from "../../engine/errors.js";
import type { ToolContext } from "@tereo-io/mcp";
import { logger } from "../../utils/logger.js";
import { ToolError } from "@tereo-io/mcp";
import {
  AppError,
  QueryFailedError,
  QueryTimeoutError,
  sourceBusy,
  SourceUnreachableError,
  TooManyRequestsError,
} from "../../utils/errors.js";

const toolError = (fn: () => unknown): ToolError => {
  try {
    fn();
  } catch (err) {
    if (err instanceof ToolError) return err;
    throw err;
  }
  throw new Error("nothing thrown");
};

describe("asToolError", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["500 server_error", new AppError(500, "server_error", "Internal error")],
    ["502 query_failed", new QueryFailedError()],
  ])("logs a %s at error, with the error", (_, err) => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => {});
    const thrown = toolError(() => asToolError(err, "req-1"));
    expect(JSON.parse(thrown.message)).toMatchObject({
      error: err.code,
      request_id: "req-1",
    });
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]![0]).toMatchObject({ err });
  });

  it.each([
    ["504 query_timeout", new QueryTimeoutError()],
    ["502 source_unreachable", new SourceUnreachableError()],
    ["503 temporarily_unavailable (a busy source)", sourceBusy()],
    [
      "429 source_busy",
      new TooManyRequestsError(1, "The source is busy", "source_busy"),
    ],
  ])(
    "does not log an expected %s again: its cause is logged where it arose",
    (_, err) => {
      const logged = (["error", "warn", "info"] as const).map((level) =>
        vi.spyOn(logger, level).mockImplementation(() => {})
      );
      const thrown = toolError(() => asToolError(err, "req-4"));
      expect(JSON.parse(thrown.message).error).toBe(err.code);
      for (const spy of logged) expect(spy).not.toHaveBeenCalled();
    }
  );

  it("does not log a 4xx at error", () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => {});
    toolError(() =>
      asToolError(
        new QueryError("not_found_or_not_accessible", "x", ["select", 0]),
        "req-2"
      )
    );
    expect(error).not.toHaveBeenCalled();
  });

  it("rethrows what is not zeteo's own error", () => {
    const err = new Error("driver text");
    expect(() => asToolError(err, "req-3")).toThrow(err);
  });
});

describe("inToolCall", () => {
  const ctx = { requestId: "mcp-call-1" } as ToolContext;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs the call as zeteo's request ctx.requestId, logging the HTTP request's id beside it once", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    const seen = await withRequestId("http-req-1", () =>
      inToolCall(ctx, async () => getRequestId())
    );
    expect(seen).toBe("mcp-call-1");
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]![0]).toEqual({
      http_request_id: "http-req-1",
      request_id: "mcp-call-1",
    });
  });

  it("turns zeteo's errors into tool errors naming the call", async () => {
    vi.spyOn(logger, "info").mockImplementation(() => {});
    await expect(
      inToolCall(ctx, () =>
        Promise.reject(new QueryError("invalid_order", "bad", ["orderBy"]))
      )
    ).rejects.toSatisfy(
      (err) =>
        err instanceof ToolError &&
        JSON.parse(err.message).request_id === "mcp-call-1"
    );
  });
});
