import { AxiosError, AxiosHeaders, CanceledError } from "axios";
import { issueFor, toApiError } from "./errors";
import { describe, expect, it } from "vitest";

const axiosError = (
  status: number,
  data: unknown,
  headers: Record<string, string> = {}
) =>
  new AxiosError("failed", "ERR_BAD_REQUEST", undefined, null, {
    status,
    statusText: "",
    data,
    headers,
    config: { headers: new AxiosHeaders() },
  });

describe("toApiError", () => {
  it("maps zeteo's body, with its issues and findings", () => {
    const err = toApiError(
      axiosError(400, {
        error: "invalid_request",
        error_description: "Bad body",
        issues: [{ path: "name", message: "Required" }],
        findings: [{ code: "no_key", detail: "No key columns" }],
      })
    );
    expect(err).toEqual({
      status: 400,
      code: "invalid_request",
      message: "Bad body",
      issues: [{ path: "name", message: "Required" }],
      findings: [{ code: "no_key", detail: "No key columns" }],
    });
  });

  it("keeps the problems of an invalid_panel", () => {
    const err = toApiError(
      axiosError(400, {
        error: "invalid_panel",
        error_description: "The chart does not fit",
        problems: [{ setting: "y.1", problem: "wrong_type" }],
      })
    );
    expect(err.problems).toEqual([{ setting: "y.1", problem: "wrong_type" }]);
  });

  it("keeps the table, column and rows of a cast_failed", () => {
    const err = toApiError(
      axiosError(422, {
        error: "cast_failed",
        error_description: "Column amount has values that are not of its type",
        table: "orders",
        column: "amount",
        rows: [3, 7],
      })
    );
    expect(err.cast).toEqual({
      table: "orders",
      column: "amount",
      rows: [3, 7],
    });
  });

  it("maps a network failure to status null and code network", () => {
    const err = toApiError(new AxiosError("Network Error", "ERR_NETWORK"));
    expect(err.status).toBeNull();
    expect(err.code).toBe("network");
    expect(err.message).toMatch(/could not be reached/i);
  });

  it("reads Retry-After as seconds", () => {
    const err = toApiError(
      axiosError(
        429,
        { error: "too_many_requests", error_description: "Slow down" },
        { "retry-after": "7" }
      )
    );
    expect(err.retryAfter).toBe(7);
  });

  it("reads Retry-After as an HTTP date, never negative", () => {
    const header = (date: Date) =>
      axiosError(429, {}, { "retry-after": date.toUTCString() });
    const future = toApiError(header(new Date(Date.now() + 30_000)));
    expect(future.retryAfter).toBeGreaterThan(25);
    expect(future.retryAfter).toBeLessThanOrEqual(30);
    expect(toApiError(header(new Date(Date.now() - 60_000))).retryAfter).toBe(
      0
    );
  });

  it("maps a cancelled request to cancelled", () => {
    expect(toApiError(new CanceledError("x")).code).toBe("cancelled");
  });

  it("maps a timeout to timeout, saying the server took too long", () => {
    const err = toApiError(new AxiosError("timeout", "ECONNABORTED"));
    expect(err.code).toBe("timeout");
    expect(err.status).toBeNull();
    expect(err.message).toMatch(/took too long/i);
  });

  it("falls back when the body is not zeteo's", () => {
    const err = toApiError(axiosError(500, "<html>"));
    expect(err.status).toBe(500);
    expect(err.code).toBe("http_500");
  });

  it("returns an ApiError unchanged", () => {
    const original = { status: 404, code: "not_found", message: "Gone" };
    expect(toApiError(original)).toBe(original);
  });
});

describe("issueFor", () => {
  const err = {
    status: 400,
    code: "invalid_request",
    message: "x",
    issues: [{ path: "name", message: "Required" }],
  };
  it("finds the message for a path", () => {
    expect(issueFor(err, "name")).toBe("Required");
  });
  it("is undefined for another path or no error", () => {
    expect(issueFor(err, "other")).toBeUndefined();
    expect(issueFor(null, "name")).toBeUndefined();
  });
});
