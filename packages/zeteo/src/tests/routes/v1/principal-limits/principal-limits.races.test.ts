// @module-tag int
// @module-tag platform
// @module-tag race
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grantsWriteToken } from "../../../support/grants.js";
import { startV1Routes } from "../../../support/v1App.js";
import { prisma } from "../../../../utils/db/prisma.js";
import { fetchJson } from "../../../support/http.js";
import { randomUUID } from "crypto";

describe("DELETE /v1/principal-limits/:id", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  const principals: string[] = [];

  const call = (method: string, path: string, body?: unknown) =>
    fetchJson(
      method,
      `${app.url}/v1/principal-limits${path}`,
      grantsWriteToken(),
      body
    );

  beforeAll(async () => {
    app = await startV1Routes();
  });
  afterAll(async () => {
    await prisma.principalLimit.deleteMany({
      where: { principalId: { in: principals } },
    });
    await app.close();
  });

  it("answers one 204 and 404 to the rest when one row is removed at once by several", async () => {
    for (let round = 0; round < 5; round++) {
      const principalId = randomUUID();
      principals.push(principalId);
      const made = await call("POST", "", {
        principal_type: "user",
        principal_id: principalId,
        query_concurrency: 3,
      });
      expect(made.status).toBe(201);

      const answers = await Promise.all(
        [1, 2, 3, 4].map(() => call("DELETE", `/${made.body.id}`))
      );
      const statuses = answers.map((a) => a.status).sort();
      expect(statuses).toEqual([204, 404, 404, 404]);
      for (const answer of answers.filter((a) => a.status === 404)) {
        expect(answer.body).toMatchObject({
          error: "not_found",
          error_description: "Principal limits not found",
        });
      }
    }
  });
});
