// @module-tag int
// @module-tag platform
import { auditRows, removeSources } from "../../../support/sources.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startV1Routes } from "../../../support/v1App.js";
import { prisma } from "../../../../utils/db/prisma.js";
import { fetchJson } from "../../../support/http.js";
import { randomUUID } from "crypto";
import {
  columnsOf,
  grantsWriteToken,
  registerSource,
  tableOf,
} from "../../../support/grants.js";

describe("grant audit entries", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  let sourceId: string;
  let table: Awaited<ReturnType<typeof tableOf>>;
  let columns: Awaited<ReturnType<typeof columnsOf>>;

  const call = (method: string, path: string, body?: unknown) =>
    fetchJson(method, `${app.url}/v1/grants${path}`, grantsWriteToken(), body);

  beforeAll(async () => {
    app = await startV1Routes();
    sourceId = await registerSource(app.url);
    table = await tableOf(sourceId, "customers");
    columns = await columnsOf(table.id);
  });
  afterAll(async () => {
    await removeSources([sourceId]);
    await app.close();
  });

  it("records one entry for each create, replace and delete", async () => {
    const principalId = randomUUID();
    const base = {
      source_id: sourceId,
      table_id: table.id,
      principal_type: "group",
      principal_id: principalId,
    };
    const made = await call("POST", "", {
      principal_type: "group",
      principal_id: principalId,
      table_id: table.id,
      all_columns: true,
    });
    expect(made.status).toBe(201);
    const id = made.body.id as string;
    expect((await auditRows(id)).map((r) => r.payload)).toEqual([
      expect.objectContaining({
        action: "CREATE",
        entityType: "grant",
        metadata: {
          ...base,
          all_columns: true,
          column_ids: [],
          event: "zeteo.grant.created",
        },
      }),
    ]);

    const ids = [columns[1]!.id, columns[0]!.id];
    const replaced = await call("PUT", `/${id}`, {
      all_columns: false,
      column_ids: ids,
    });
    expect(replaced.status).toBe(200);
    const afterReplace = await auditRows(id);
    expect(afterReplace).toHaveLength(2);
    expect(afterReplace[1]!.payload).toMatchObject({
      action: "UPDATE",
      entityType: "grant",
      metadata: {
        ...base,
        all_columns: false,
        event: "zeteo.grant.updated",
      },
    });
    expect([...afterReplace[1]!.payload.metadata.column_ids].sort()).toEqual(
      [...ids].sort()
    );

    expect((await call("DELETE", `/${id}`)).status).toBe(204);
    const afterDelete = await auditRows(id);
    expect(afterDelete).toHaveLength(3);
    expect(afterDelete[2]!.payload).toMatchObject({
      action: "DELETE",
      entityType: "grant",
      metadata: {
        ...base,
        all_columns: false,
        event: "zeteo.grant.removed",
      },
    });
    expect([...afterDelete[2]!.payload.metadata.column_ids].sort()).toEqual(
      [...ids].sort()
    );
  });

  it("records nothing for a refused create, replace or delete", async () => {
    const principalId = randomUUID();
    const count = () =>
      prisma.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*) AS n FROM "core"."core_outbox"
        WHERE payload->'metadata'->>'principal_id' = ${principalId}`.then(
        (rows) => Number(rows[0]!.n)
      );

    const refused = await call("POST", "", {
      principal_type: "user",
      principal_id: principalId,
      table_id: table.id,
      all_columns: false,
      column_ids: [randomUUID()],
    });
    expect(refused.status).toBe(422);
    expect(await count()).toBe(0);

    const made = await call("POST", "", {
      principal_type: "user",
      principal_id: principalId,
      table_id: table.id,
      all_columns: true,
    });
    expect(made.status).toBe(201);
    expect(await count()).toBe(1);

    const duplicate = await call("POST", "", {
      principal_type: "user",
      principal_id: principalId,
      table_id: table.id,
      all_columns: true,
    });
    expect(duplicate.status).toBe(409);
    const badReplace = await call("PUT", `/${made.body.id}`, {
      all_columns: false,
      column_ids: [randomUUID()],
    });
    expect(badReplace.status).toBe(422);
    expect((await call("DELETE", `/${randomUUID()}`)).status).toBe(404);
    expect(await count()).toBe(1);
  });
});
