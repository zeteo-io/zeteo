// @module-tag int
// @module-tag platform
import { grantsReadToken, grantsWriteToken } from "../../../support/grants.js";
import { clearOrphaned, markOrphaned } from "../../../support/principals.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startV1Routes } from "../../../support/v1App.js";
import { prisma } from "../../../../utils/db/prisma.js";
import { tokenFor } from "../../../support/tokens.js";
import { fetchJson } from "../../../support/http.js";
import { randomUUID } from "crypto";

const noPermissions = () => tokenFor({ permissions: [] });

describe("/v1/principal-limits", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  const principals: string[] = [];

  const call = (
    method: string,
    path: string,
    token: string | null = grantsWriteToken(),
    body?: unknown
  ) => fetchJson(method, `${app.url}/v1/principal-limits${path}`, token, body);

  /** Limits for a fresh user unless overridden. */
  const create = (overrides: Record<string, unknown> = {}) => {
    const body = {
      principal_type: "user",
      principal_id: randomUUID(),
      query_concurrency: 3,
      ...overrides,
    };
    principals.push(body.principal_id as string);
    return call("POST", "", grantsWriteToken(), body);
  };

  beforeAll(async () => {
    app = await startV1Routes();
  });
  afterAll(async () => {
    await prisma.principalLimit.deleteMany({
      where: { principalId: { in: principals } },
    });
    await app.close();
  });

  describe("POST /", () => {
    it("creates limits and answers 201 with the view", async () => {
      const principalId = randomUUID();
      const res = await create({
        principal_id: principalId,
        query_concurrency: 7,
        export_concurrency: 2,
      });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        id: expect.any(String),
        principal_type: "user",
        principal_id: principalId,
        principal_status: "active",
        query_concurrency: 7,
        export_concurrency: 2,
        created_by: expect.any(String),
        created_at: expect.any(String),
        updated_at: expect.any(String),
      });
    });

    it("takes either limit alone, the other shown as null", async () => {
      const queries = await create({ principal_type: "group" });
      expect(queries.status).toBe(201);
      expect(queries.body).toMatchObject({
        principal_type: "group",
        query_concurrency: 3,
        export_concurrency: null,
      });
      const exports = await create({
        query_concurrency: undefined,
        export_concurrency: 10,
      });
      expect(exports.status).toBe(201);
      expect(exports.body).toMatchObject({
        query_concurrency: null,
        export_concurrency: 10,
      });
    });

    it("answers 400 invalid_request when neither limit is given or one is out of range", async () => {
      for (const limits of [
        { query_concurrency: undefined },
        { query_concurrency: 0 },
        { query_concurrency: 101 },
        { export_concurrency: 11 },
        { query_concurrency: 2.5 },
      ]) {
        const res = await create(limits);
        expect(res.status, JSON.stringify(limits)).toBe(400);
        expect(res.body.error).toBe("invalid_request");
      }
    });

    it("answers 409 conflict when the principal already has limits", async () => {
      const principalId = randomUUID();
      expect((await create({ principal_id: principalId })).status).toBe(201);
      const again = await create({ principal_id: principalId });
      expect(again.status).toBe(409);
      expect(again.body.error).toBe("conflict");
      // The same id as a group is another principal.
      const asGroup = await create({
        principal_id: principalId,
        principal_type: "group",
      });
      expect(asGroup.status).toBe(201);
    });

    it("answers 403 to a read-only caller and 401 without a token", async () => {
      expect((await call("POST", "", grantsReadToken(), {})).status).toBe(403);
      expect((await call("POST", "", null, {})).status).toBe(401);
    });
  });

  describe("GET /:id", () => {
    it("returns the limits to a read-only caller", async () => {
      const made = await create();
      const res = await call("GET", `/${made.body.id}`, grantsReadToken());
      expect(res.status).toBe(200);
      expect(res.body).toEqual(made.body);
    });

    it("answers 404 for unknown limits, 400 for a malformed id, 403 without permission", async () => {
      expect(
        (await call("GET", `/${randomUUID()}`, grantsReadToken())).status
      ).toBe(404);
      expect((await call("GET", "/nope", grantsReadToken())).status).toBe(400);
      const made = await create();
      expect(
        (await call("GET", `/${made.body.id}`, noPermissions())).status
      ).toBe(403);
    });

    it("reports a user Tereo no longer knows as orphaned", async () => {
      const principalId = randomUUID();
      const made = await create({ principal_id: principalId });
      await markOrphaned(principalId);
      try {
        const res = await call("GET", `/${made.body.id}`, grantsReadToken());
        expect(res.body.principal_status).toBe("orphaned");
      } finally {
        await clearOrphaned(principalId);
      }
    });
  });

  describe("PATCH /:id", () => {
    it("changes either limit, keeps the other, and clears one with null", async () => {
      const made = await create({
        query_concurrency: 3,
        export_concurrency: 1,
      });
      const path = `/${made.body.id}`;
      const raised = await call("PATCH", path, grantsWriteToken(), {
        export_concurrency: 4,
      });
      expect(raised.status).toBe(200);
      expect(raised.body).toMatchObject({
        id: made.body.id,
        query_concurrency: 3,
        export_concurrency: 4,
      });
      const cleared = await call("PATCH", path, grantsWriteToken(), {
        query_concurrency: null,
      });
      expect(cleared.status).toBe(200);
      expect(cleared.body).toMatchObject({
        query_concurrency: null,
        export_concurrency: 4,
      });
    });

    it("answers 400 for a change that would clear both limits, and keeps the row", async () => {
      const made = await create({ query_concurrency: 3 });
      const path = `/${made.body.id}`;
      for (const body of [
        { query_concurrency: null },
        { query_concurrency: null, export_concurrency: null },
      ]) {
        const res = await call("PATCH", path, grantsWriteToken(), body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.body.error).toBe("invalid_request");
      }
      const kept = await call("GET", path, grantsReadToken());
      expect(kept.body.query_concurrency).toBe(3);
    });

    it("answers 400 for an empty or out-of-range change", async () => {
      const made = await create();
      for (const body of [
        {},
        { export_concurrency: 0 },
        { principal_id: randomUUID() },
      ]) {
        const res = await call(
          "PATCH",
          `/${made.body.id}`,
          grantsWriteToken(),
          body
        );
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
    });

    it("answers 404 for unknown limits, 403 to a read-only caller", async () => {
      const body = { query_concurrency: 2 };
      expect(
        (await call("PATCH", `/${randomUUID()}`, grantsWriteToken(), body))
          .status
      ).toBe(404);
      const made = await create();
      expect(
        (await call("PATCH", `/${made.body.id}`, grantsReadToken(), body))
          .status
      ).toBe(403);
    });
  });

  describe("DELETE /:id", () => {
    it("removes the limits and answers 204", async () => {
      const made = await create();
      const res = await call("DELETE", `/${made.body.id}`);
      expect(res.status).toBe(204);
      expect(res.body).toBeNull();
      expect(
        (await call("GET", `/${made.body.id}`, grantsReadToken())).status
      ).toBe(404);
    });

    it("answers 404 for unknown limits, 403 to a read-only caller", async () => {
      expect((await call("DELETE", `/${randomUUID()}`)).status).toBe(404);
      const made = await create();
      expect(
        (await call("DELETE", `/${made.body.id}`, grantsReadToken())).status
      ).toBe(403);
    });
  });

  describe("GET /", () => {
    const principalId = randomUUID();
    const ids: string[] = [];

    beforeAll(async () => {
      // One id as a user and as a group, then another user.
      for (const body of [
        { principal_id: principalId },
        { principal_id: principalId, principal_type: "group" },
        {},
      ]) {
        const res = await create(body);
        expect(res.status).toBe(201);
        ids.push(res.body.id);
      }
    });

    const list = (query: string) => call("GET", `?${query}`, grantsReadToken());
    const idsOf = (body: { data: Array<{ id: string }> }) =>
      body.data.map((l) => l.id);

    it("filters by principal id and type", async () => {
      const byId = await list(`principal_id=${principalId}`);
      expect(byId.status).toBe(200);
      expect(idsOf(byId.body)).toEqual(ids.slice(0, 2));
      expect(byId.body.next_cursor).toBeNull();
      const asGroup = await list(
        `principal_type=group&principal_id=${principalId}`
      );
      expect(idsOf(asGroup.body)).toEqual([ids[1]]);
    });

    it("pages in creation order with a cursor", async () => {
      const first = await list(`principal_id=${principalId}&limit=1`);
      expect(idsOf(first.body)).toEqual([ids[0]]);
      expect(first.body.next_cursor).toEqual(expect.any(String));
      const second = await list(
        `principal_id=${principalId}&limit=1&cursor=${first.body.next_cursor}`
      );
      expect(idsOf(second.body)).toEqual([ids[1]]);
      expect(second.body.next_cursor).toBeNull();
    });

    it("marks an orphaned principal's limits", async () => {
      await markOrphaned(principalId);
      try {
        const res = await list(
          `principal_type=user&principal_id=${principalId}`
        );
        expect(
          res.body.data.map(
            (l: { principal_status: string }) => l.principal_status
          )
        ).toEqual(["orphaned"]);
      } finally {
        await clearOrphaned(principalId);
      }
    });

    it("answers 400 for a bad filter, limit or cursor, 403 without permission", async () => {
      for (const query of [
        "principal_type=robot",
        "principal_id=nope",
        "limit=0",
        "limit=101",
        "cursor=!!",
        "cursor=W10",
        "extra=1",
      ]) {
        expect((await list(query)).status, query).toBe(400);
      }
      expect((await call("GET", "", noPermissions())).status).toBe(403);
    });
  });
});
