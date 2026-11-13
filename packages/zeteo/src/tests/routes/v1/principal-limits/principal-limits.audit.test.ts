// @module-tag int
// @module-tag platform
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grantsWriteToken } from "../../../support/grants.js";
import { startV1Routes } from "../../../support/v1App.js";
import { auditRows } from "../../../support/sources.js";
import { prisma } from "../../../../utils/db/prisma.js";
import { fetchJson } from "../../../support/http.js";
import { randomUUID } from "crypto";

describe("principal limit audit entries", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  const principals: string[] = [];

  const call = (method: string, path: string, body?: unknown) =>
    fetchJson(
      method,
      `${app.url}/v1/principal-limits${path}`,
      grantsWriteToken(),
      body
    );

  /** Outbox entries naming the principal. */
  const entriesFor = (principalId: string) =>
    prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM "core"."core_outbox"
      WHERE payload->'metadata'->>'principal_id' = ${principalId}`.then(
      (rows) => Number(rows[0]!.n)
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

  it("records one entry for each create, change and removal", async () => {
    const principalId = randomUUID();
    principals.push(principalId);
    const base = { principal_type: "group", principal_id: principalId };
    const made = await call("POST", "", { ...base, query_concurrency: 4 });
    expect(made.status).toBe(201);
    const id = made.body.id as string;
    expect((await auditRows(id)).map((r) => r.payload)).toEqual([
      expect.objectContaining({
        action: "CREATE",
        entityType: "principal_limit",
        metadata: {
          ...base,
          query_concurrency: 4,
          export_concurrency: null,
          event: "zeteo.principal_limit.created",
        },
      }),
    ]);

    const changed = await call("PATCH", `/${id}`, {
      query_concurrency: 6,
      export_concurrency: 2,
    });
    expect(changed.status).toBe(200);
    const afterChange = await auditRows(id);
    expect(afterChange).toHaveLength(2);
    expect(afterChange[1]!.payload).toMatchObject({
      action: "UPDATE",
      entityType: "principal_limit",
      metadata: {
        ...base,
        query_concurrency: 6,
        export_concurrency: 2,
        previous: { query_concurrency: 4, export_concurrency: null },
        event: "zeteo.principal_limit.updated",
      },
    });

    expect((await call("DELETE", `/${id}`)).status).toBe(204);
    const afterDelete = await auditRows(id);
    expect(afterDelete).toHaveLength(3);
    expect(afterDelete[2]!.payload).toMatchObject({
      action: "DELETE",
      entityType: "principal_limit",
      metadata: {
        ...base,
        query_concurrency: 6,
        export_concurrency: 2,
        event: "zeteo.principal_limit.removed",
      },
    });
  });

  it("records nothing for a refused create, change or removal", async () => {
    const principalId = randomUUID();
    principals.push(principalId);
    const body = {
      principal_type: "user",
      principal_id: principalId,
      export_concurrency: 2,
    };
    const made = await call("POST", "", body);
    expect(made.status).toBe(201);
    expect(await entriesFor(principalId)).toBe(1);

    expect((await call("POST", "", body)).status).toBe(409);
    expect(
      (
        await call("PATCH", `/${made.body.id}`, {
          export_concurrency: null,
        })
      ).status
    ).toBe(400);
    expect((await call("DELETE", `/${randomUUID()}`)).status).toBe(404);
    expect(await entriesFor(principalId)).toBe(1);
  });
});
