// @module-tag int
// @module-tag platform
import { SEARCH_LIMIT_PER_MINUTE } from "../../../../../principals/searchRateLimit.js";
import { GRANTS_READ } from "../../../../../definitions/tereoDeclaration.js";
import { MAX_DIRECTORY } from "../../../../../principals/directory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startV1Routes } from "../../../../support/v1App.js";
import { tokenFor } from "../../../../support/tokens.js";
import { fetchJson } from "../../../../support/http.js";
import { randomUUID } from "crypto";
import {
  clearDirectory,
  seedDirectory,
} from "../../../../support/principals.js";

describe("GET /v1/principals/all limits", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  const list = (token: string) =>
    fetchJson("GET", `${app.url}/v1/principals/all`, token);

  beforeAll(async () => {
    app = await startV1Routes();
  });
  afterAll(async () => {
    await clearDirectory();
    await app.close();
  });

  it("lists at most 5000 users and says truncated past it", async () => {
    expect(MAX_DIRECTORY).toBe(5000);
    const users = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        type: "user" as const,
        id: randomUUID(),
        name: `User ${i}`,
        email: null,
        status: "active" as const,
      }));
    await seedDirectory(users(MAX_DIRECTORY));
    const full = await list(tokenFor({ permissions: [GRANTS_READ] }));
    expect(full.body.data).toHaveLength(MAX_DIRECTORY);
    expect(full.body.truncated).toBe(false);

    await seedDirectory(users(MAX_DIRECTORY + 1));
    const over = await list(tokenFor({ permissions: [GRANTS_READ] }));
    expect(over.status).toBe(200);
    expect(over.body.data).toHaveLength(MAX_DIRECTORY);
    expect(over.body.truncated).toBe(true);
  });

  it("counts against the caller's searches a minute", async () => {
    await seedDirectory([]);
    const token = tokenFor({ permissions: [GRANTS_READ] });
    for (let i = 0; i < SEARCH_LIMIT_PER_MINUTE; i++) {
      expect((await list(token)).status).toBe(200);
    }
    const res = await list(token);
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("too_many_requests");
  });
});
