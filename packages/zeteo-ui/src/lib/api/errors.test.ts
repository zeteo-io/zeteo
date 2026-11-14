import { AxiosError, AxiosHeaders } from "axios";
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
