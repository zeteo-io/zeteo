// @module-tag int
// @module-tag platform
import { BASE_URL, fetchJson } from "../../support/http.js";
import { describe, expect, it } from "vitest";

describe("GET /health", () => {
  it("answers 200 with status ok when Postgres and Redis answer", async () => {
    const { status, body } = await fetchJson("GET", `${BASE_URL}/health`, null);
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: "ok" });
  });
});
