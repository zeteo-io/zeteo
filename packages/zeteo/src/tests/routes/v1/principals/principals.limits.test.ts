// @module-tag int
// @module-tag platform
import { clearDirectory, seedDirectory } from "../../../support/principals.js";
import { GRANTS_READ } from "../../../../definitions/tereoDeclaration.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startV1Routes } from "../../../support/v1App.js";
import { tokenFor } from "../../../support/tokens.js";
import { fetchJson } from "../../../support/http.js";
import { randomUUID } from "crypto";

describe("/v1/principals rate limit", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;

  const search = (token: string) =>
    fetchJson("GET", `${app.url}/v1/principals?type=user&q=nobody`, token);

  beforeAll(async () => {
    app = await startV1Routes();
    await seedDirectory([]);
  });
  afterAll(async () => {
    await clearDirectory();
    await app.close();
  });

  it("limits one caller's searches to 60 a minute, with Retry-After", async () => {
    const token = tokenFor({ permissions: [GRANTS_READ] });
    for (let i = 0; i < 60; i++) {
      expect((await search(token)).status).toBe(200);
    }
    const res = await fetch(`${app.url}/v1/principals?type=user&q=nobody`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toBe(
      "too_many_requests"
    );
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);

    const other = await search(tokenFor({ permissions: [GRANTS_READ] }));
    expect(other.status).toBe(200);
  });

  it("does not count lookups", async () => {
    const token = tokenFor({ permissions: [GRANTS_READ] });
    for (let i = 0; i < 65; i++) {
      const res = await fetchJson(
        "POST",
        `${app.url}/v1/principals/lookup`,
        token,
        { principals: [{ type: "user", id: randomUUID() }] }
      );
      expect(res.status).toBe(200);
    }
    expect((await search(token)).status).toBe(200);
  });
});
