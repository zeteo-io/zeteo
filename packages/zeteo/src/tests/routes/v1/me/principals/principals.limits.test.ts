// @module-tag int
// @module-tag platform
import { SEARCH_LIMIT_PER_MINUTE } from "../../../../../principals/searchRateLimit.js";
import { DATA_READ } from "../../../../../definitions/tereoDeclaration.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startV1Routes } from "../../../../support/v1App.js";
import { tokenFor } from "../../../../support/tokens.js";
import { fetchJson } from "../../../../support/http.js";
import {
  clearDirectory,
  seedDirectory,
} from "../../../../support/principals.js";

describe("/v1/me/principals rate limit", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  const search = (token: string) =>
    fetchJson("GET", `${app.url}/v1/me/principals?type=user&q=nobody`, token);

  beforeAll(async () => {
    app = await startV1Routes();
    await seedDirectory([]);
  });
  afterAll(async () => {
    await clearDirectory();
    await app.close();
  });

  it("limits one caller's searches to 60 a minute, with Retry-After", async () => {
    const token = tokenFor({ permissions: [DATA_READ] });
    for (let i = 0; i < SEARCH_LIMIT_PER_MINUTE; i++) {
      expect((await search(token)).status).toBe(200);
    }
    const res = await fetch(`${app.url}/v1/me/principals?type=user&q=nobody`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await search(tokenFor({ permissions: [DATA_READ] }))).status).toBe(
      200
    );
  });
});
