// @module-tag int
// @module-tag platform
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeSources } from "../../../../../support/sources.js";
import { registerSource } from "../../../../../support/grants.js";
import { startV1Routes } from "../../../../../support/v1App.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { tokenFor } from "../../../../../support/tokens.js";
import { fetchJson } from "../../../../../support/http.js";
import { randomUUID } from "crypto";
import {
  DATA_READ,
  FILE_SOURCES_WRITE,
} from "../../../../../../definitions/tereoDeclaration.js";
import {
  removeUploadSources,
  seedUploadSource,
  type UploadTableSpec,
} from "../../../../../support/fileSources.js";

const CUSTOMERS: UploadTableSpec = {
  name: "customers",
  columns: [
    { name: "id", type: "number" },
    { name: "name", type: "text" },
  ],
  rows: [["1", "Acme"]],
};

const ownerId = randomUUID();
const owner = tokenFor({
  userId: ownerId,
  permissions: [DATA_READ, FILE_SOURCES_WRITE],
});
const nobody = tokenFor({ permissions: [] });

const bodyOf = (res: { body: Record<string, unknown> }) => {
  const { request_id: _, ...rest } = res.body;
  return rest;
};

describe("/v1/sources/:sourceId/tables (file sources)", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  let own: Awaited<ReturnType<typeof seedUploadSource>>;
  let others: Awaited<ReturnType<typeof seedUploadSource>>;
  let databaseSourceId: string;

  const patch = (path: string, token: string, body: unknown) =>
    fetchJson("PATCH", `${app.url}/v1/sources${path}`, token, body);
  const get = (path: string, token: string) =>
    fetchJson("GET", `${app.url}/v1/sources${path}`, token);

  beforeAll(async () => {
    app = await startV1Routes();
    own = await seedUploadSource({ ownerId, tables: [CUSTOMERS] });
    others = await seedUploadSource({
      ownerId: randomUUID(),
      tables: [CUSTOMERS],
    });
    databaseSourceId = await registerSource(app.url);
  });
  afterAll(async () => {
    await removeUploadSources([own.id, others.id]);
    await removeSources([databaseSourceId]);
    await app.close();
  });

  it("lets the owner list and read their source's tables", async () => {
    const list = await get(`/${own.id}/tables`, owner);
    expect(list.status).toBe(200);
    expect((list.body.data as { name: string }[]).map((t) => t.name)).toEqual([
      "customers",
    ]);
    const one = await get(
      `/${own.id}/tables/${own.tables.customers!.id}`,
      owner
    );
    expect(one.status).toBe(200);
    expect(one.body.name).toBe("customers");
  });

  it("refuses the owner the tables of another source with the very 403 of anyone", async () => {
    const dbTable = await prisma.sourceTable.findFirstOrThrow({
      where: { sourceId: databaseSourceId, name: "customers" },
    });
    for (const path of [
      `/${databaseSourceId}/tables`,
      `/${others.id}/tables`,
      `/${randomUUID()}/tables`,
      `/${databaseSourceId}/tables/${dbTable.id}`,
      `/${others.id}/tables/${others.tables.customers!.id}`,
      `/${databaseSourceId}/tables/${own.tables.customers!.id}`,
    ]) {
      const res = await get(path, owner);
      expect(res.status, path).toBe(403);
      expect(bodyOf(res)).toEqual(bodyOf(await get(path, nobody)));
    }
  });

  it("lets the owner describe their table and its columns", async () => {
    const res = await patch(
      `/${own.id}/tables/${own.tables.customers!.id}`,
      owner,
      {
        description: "Our customers",
        columns: [{ name: "name", description: "Trading name" }],
      }
    );
    expect(res.status).toBe(200);
    expect(res.body.description).toBe("Our customers");
  });

  it("refuses the owner on a database source or another owner's file source, as today", async () => {
    const dbTable = await prisma.sourceTable.findFirstOrThrow({
      where: { sourceId: databaseSourceId, name: "customers" },
    });
    const body = { description: "Not yours" };
    for (const path of [
      `/${databaseSourceId}/tables/${dbTable.id}`,
      `/${others.id}/tables/${others.tables.customers!.id}`,
      // A table of the owner's own source, named under another source.
      `/${databaseSourceId}/tables/${own.tables.customers!.id}`,
    ]) {
      const res = await patch(path, owner, body);
      expect(res.status, path).toBe(403);
      expect(bodyOf(res)).toEqual(bodyOf(await patch(path, nobody, body)));
    }
  });

  it("refuses an owner who no longer holds zeteo.file_sources.write", async () => {
    const lapsed = tokenFor({ userId: ownerId, permissions: [DATA_READ] });
    const res = await patch(
      `/${own.id}/tables/${own.tables.customers!.id}`,
      lapsed,
      { description: "Lapsed" }
    );
    expect(res.status).toBe(403);
  });
});
