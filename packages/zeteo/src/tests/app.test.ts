// @module-tag int
// @module-tag platform
import { BASE_URL, fetchJson } from "./support/http.js";
import { describe, expect, it } from "vitest";

describe("app", () => {
  it("names the request in every error body, as its X-Request-ID header does", async () => {
    const response = await fetch(`${BASE_URL}/v1/catalog`);
    const body = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(401);
    expect(body.request_id).toEqual(expect.any(String));
    expect(body.request_id).toBe(response.headers.get("x-request-id"));
  });

  it("keeps a well-formed request id the client sent", async () => {
    const res = await fetchJson(
      "GET",
      `${BASE_URL}/v1/catalog`,
      null,
      undefined,
      {
        "X-Request-ID": "client-req-42",
      }
    );
    expect(res.status).toBe(401);
    expect(res.body.request_id).toBe("client-req-42");
  });
});
