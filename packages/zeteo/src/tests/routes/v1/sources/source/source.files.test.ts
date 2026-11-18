// @module-tag int
// @module-tag platform
import { auditRows, removeSources } from "../../../../support/sources.js";
import { postQuery, removeRunsOf } from "../../../../support/queries.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerSource } from "../../../../support/grants.js";
import { startV1Routes } from "../../../../support/v1App.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import { tokenFor } from "../../../../support/tokens.js";
import { fetchJson } from "../../../../support/http.js";
import { randomUUID } from "crypto";
import {
  DATA_READ,
  UPLOADS_WRITE,
  GRANTS_READ,
  GRANTS_WRITE,
  SOURCES_READ,
  SOURCES_WRITE,
} from "../../../../../definitions/tereoDeclaration.js";
import {
  createUploadSource,
  csvOf,
  uploadTablesOf,
  removeUploadSourcesOf,
  removeUploadSources,
  schemaExists,
  seedUploadSource,
  sourcesCall,
  stageFile,
} from "../../../../support/uploads.js";

const ownerId = randomUUID();
const owner = tokenFor({
  userId: ownerId,
  permissions: [DATA_READ, UPLOADS_WRITE],
});
const otherId = randomUUID();
const other = tokenFor({
  userId: otherId,
  permissions: [DATA_READ, UPLOADS_WRITE],
});
const adminId = randomUUID();
const admin = tokenFor({
  userId: adminId,
  permissions: [DATA_READ, SOURCES_READ, SOURCES_WRITE],
});
const reader = tokenFor({
  userId: randomUUID(),
  permissions: [DATA_READ, SOURCES_READ],
});
// The owner without the permission to manage upload sources.
const demoted = tokenFor({ userId: ownerId, permissions: [DATA_READ] });
const nobody = tokenFor({ permissions: [] });

const CSV = csvOf(
  ["id", "name"],
  [
    ["1", "a"],
    ["2", "b"],
  ]
);

const bodyOf = (res: { body: Record<string, unknown> }) => {
  const { request_id: _, ...rest } = res.body;
  return rest;
};

let app: Awaited<ReturnType<typeof startV1Routes>>;
let seededId: string;
let othersId: string;
let databaseSourceId: string;
const call = (method: string, path: string, token: string, body?: unknown) =>
  sourcesCall(app.url, method, path, token, body);
const make = () => createUploadSource(app.url, owner, ownerId, CSV);

beforeAll(async () => {
  app = await startV1Routes();
  seededId = (await seedUploadSource({ ownerId, tables: [] })).id;
  othersId = (await seedUploadSource({ ownerId: randomUUID(), tables: [] })).id;
  databaseSourceId = await registerSource(app.url);
});
afterAll(async () => {
  await removeRunsOf([ownerId, otherId, adminId]);
  await removeUploadSources([seededId, othersId]);
  await removeUploadSourcesOf([ownerId, otherId, adminId]);
  await removeSources([databaseSourceId]);
  await app.close();
});

describe("/v1/sources/:sourceId (upload)", () => {
  it("GET shows the owner their own source, which carries no settings", async () => {
    const res = await call("GET", `/${seededId}`, owner);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: seededId,
      type: "upload",
      owner_id: ownerId,
      settings: null,
      size_bytes: 0,
      size_measured_at: null,
      share_count: 0,
    });
    expect(res.body).not.toHaveProperty("sealed_settings");
    expect(res.body).not.toHaveProperty("sealedSettings");
  });

  it("GET reports an upload's last load as its last refresh, null before any", async () => {
    const empty = await call("GET", `/${seededId}`, owner);
    expect(empty.body.last_refreshed_at).toBeNull();
    const created = await make();
    const res = await call("GET", `/${created.id}`, owner);
    const tables = await call("GET", `/${created.id}/tables`, owner);
    const loads = (tables.body.data as { last_loaded_at: string }[]).map(
      (t) => t.last_loaded_at
    );
    expect(res.body.last_refreshed_at).toBe(loads.sort().at(-1));
  });

  it("GET shows the source to its owner and to an admin alike", async () => {
    const source = await make();
    const { tables: _, ...view } = source;
    for (const token of [owner, admin, reader]) {
      const res = await call("GET", `/${source.id}`, token);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(view);
    }
  });

  it("GET refuses the owner any other source with the very 403 of anyone", async () => {
    for (const path of [
      `/${databaseSourceId}`,
      `/${othersId}`,
      `/${randomUUID()}`,
      "/not-an-id",
    ]) {
      const res = await call("GET", path, owner);
      expect(res.status, path).toBe(403);
      expect(bodyOf(res)).toEqual(bodyOf(await call("GET", path, nobody)));
    }
  });

  it("GET refuses anyone without zeteo.sources.read who is not an owner", async () => {
    expect((await call("GET", `/${seededId}`, nobody)).status).toBe(403);
    const plain = tokenFor({ permissions: [DATA_READ] });
    expect((await call("GET", `/${seededId}`, plain)).status).toBe(403);
  });

  it.each([
    ["PATCH", { name: "Mine now" }],
    ["DELETE", undefined],
  ])(
    "%s answers someone else, and an unknown id, as it answers anyone without the permission",
    async (method, body) => {
      const source = await make();
      for (const [token, path] of [
        [other, `/${source.id}`],
        [demoted, `/${source.id}`],
        [reader, `/${source.id}`],
        [owner, `/${randomUUID()}`],
      ] as const) {
        const res = await call(method, path, token, body);
        expect(res.status).toBe(403);
        expect(bodyOf(res)).toEqual(
          bodyOf(await call(method, path, nobody, body))
        );
      }
      expect(await schemaExists(source.id)).toBe(true);
      // An admin is told it does not exist.
      const missing = await call(method, `/${randomUUID()}`, admin, body);
      expect(missing.status).toBe(404);
    }
  );

  it("PATCH renames it, for the owner or an admin", async () => {
    const source = await make();
    const res = await call("PATCH", `/${source.id}`, owner, {
      name: "Renamed",
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: source.id,
      name: "Renamed",
      type: "upload",
    });
    const byAdmin = await call("PATCH", `/${source.id}`, admin, {
      name: "By admin",
    });
    expect(byAdmin.body.name).toBe("By admin");
    const bad = await call("PATCH", `/${source.id}`, owner, { slug: "x" });
    expect(bad.status).toBe(400);
  });

  it("keeps a description given at create, changed by the owner or an admin", async () => {
    const staged = await stageFile(ownerId, CSV);
    const created = await call("POST", "", owner, {
      type: "upload",
      staging_id: staged.stagingId,
      name: "Described",
      description: "Orders exported from the shop",
      tables: [{ key: "csv", name: "data" }],
    });
    expect(created.status).toBe(201);
    expect(created.body.description).toBe("Orders exported from the shop");
    const read = await call("GET", `/${created.body.id}`, owner);
    expect(read.body.description).toBe("Orders exported from the shop");

    const byOwner = await call("PATCH", `/${created.body.id}`, owner, {
      name: "Shop orders",
      description: "  Orders from the shop  ",
    });
    expect(byOwner.status).toBe(200);
    expect(byOwner.body).toMatchObject({
      name: "Shop orders",
      description: "Orders from the shop",
    });
    const byAdmin = await call("PATCH", `/${created.body.id}`, admin, {
      description: "",
      row_cap: 5,
    });
    expect(byAdmin.status).toBe(200);
    expect(byAdmin.body).toMatchObject({ description: "", row_cap: 5 });

    const updates = (await auditRows(created.body.id)).filter(
      (r) => r.payload.metadata.event === "zeteo.source.updated"
    );
    expect(updates.map((r) => r.payload.metadata.changed)).toEqual([
      ["name", "description"],
      ["description", "row_cap"],
    ]);

    const without = await make();
    expect(without.description).toBe("");
  });

  it("PATCH refuses the owner its limits, which are an admin's", async () => {
    const source = await make();
    const res = await call("PATCH", `/${source.id}`, owner, { row_cap: 5 });
    expect(res.status).toBe(403);
    const both = await call("PATCH", `/${source.id}`, owner, {
      name: "Capped",
      row_cap: 5,
    });
    expect(both.status).toBe(403);
    const byAdmin = await call("PATCH", `/${source.id}`, admin, {
      name: "Capped",
      row_cap: 5,
    });
    expect(byAdmin.status).toBe(200);
    expect(byAdmin.body).toMatchObject({ name: "Capped", row_cap: 5 });
  });

  it("DELETE archives it, drops its schema, and marks its tables missing", async () => {
    const source = await make();
    const query = {
      source: source.slug,
      from: "data",
      select: ["id"],
    };
    expect((await postQuery(owner, query, app.url)).status).toBe(200);

    const res = await call("DELETE", `/${source.id}`, owner);
    expect(res.status).toBe(204);
    expect(await schemaExists(source.id)).toBe(false);
    const row = await prisma.source.findUniqueOrThrow({
      where: { id: source.id },
      include: { tables: { include: { columns: true } } },
    });
    expect(row.archivedAt).not.toBeNull();
    expect(row.tables).toHaveLength(1);
    expect(row.tables[0]!.id).toBe(source.tables[0]!.id);
    expect(row.tables[0]!.missingSince).not.toBeNull();
    expect(row.tables[0]!.columns.every((c) => c.missingSince)).toBe(true);
    // Grants stay, as for any archived source.
    expect(
      await prisma.grant.count({ where: { tableId: source.tables[0]!.id } })
    ).toBe(1);

    const after = await postQuery(owner, query, app.url);
    const unknown = await postQuery(
      owner,
      { ...query, source: `nope-${randomUUID().slice(0, 8)}` },
      app.url
    );
    expect([after.status, after.body.error]).toEqual([
      unknown.status,
      unknown.body.error,
    ]);

    const view = await call("GET", `/${source.id}`, owner);
    expect(view.status).toBe(200);
    expect(view.body.archived_at).toEqual(expect.any(String));
    expect(view.body.size_bytes).toBe(0);
    expect((await uploadTablesOf(source.id))[0]!.missing).toBe(true);
    const again = await call("DELETE", `/${source.id}`, owner);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("source_archived");
    // An archived one is not listed.
    const list = await call("GET", "?owner_id=me", owner);
    expect(list.body.data.map((s: { id: string }) => s.id)).not.toContain(
      source.id
    );
  });

  it("DELETE clears the owner grants' flag, so an admin can remove them", async () => {
    const source = await make();
    const tableId = source.tables[0]!.id;
    const grant = await prisma.grant.findFirstOrThrow({
      where: { tableId, ownerGrant: true },
    });
    const grantsAdmin = tokenFor({
      userId: adminId,
      permissions: [DATA_READ, GRANTS_READ, GRANTS_WRITE],
    });
    const locked = await fetchJson(
      "DELETE",
      `${app.url}/v1/grants/${grant.id}`,
      grantsAdmin
    );
    expect([locked.status, locked.body.error]).toEqual([
      409,
      "owner_grant_locked",
    ]);

    expect((await call("DELETE", `/${source.id}`, owner)).status).toBe(204);
    expect(
      await prisma.grant.findUniqueOrThrow({ where: { id: grant.id } })
    ).toMatchObject({ ownerGrant: false });
    const removed = await fetchJson(
      "DELETE",
      `${app.url}/v1/grants/${grant.id}`,
      grantsAdmin
    );
    expect(removed.status, JSON.stringify(removed.body)).toBe(204);
    expect(await prisma.grant.count({ where: { tableId } })).toBe(0);
  });

  it("DELETE by an admin works on anyone's source", async () => {
    const source = await make();
    expect((await call("DELETE", `/${source.id}`, admin)).status).toBe(204);
    expect(await schemaExists(source.id)).toBe(false);
  });

  it("DELETE answers 409 not_an_upload_source for a database source, which is archived instead", async () => {
    const res = await call("DELETE", `/${databaseSourceId}`, admin);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_an_upload_source");
    const row = await prisma.source.findUniqueOrThrow({
      where: { id: databaseSourceId },
    });
    expect(row.archivedAt).toBeNull();
  });
});
