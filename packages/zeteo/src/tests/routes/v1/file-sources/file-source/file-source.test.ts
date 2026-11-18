// @module-tag int
// @module-tag platform
import { postQuery, removeRunsOf } from "../../../../support/queries.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startV1Routes } from "../../../../support/v1App.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import { tokenFor } from "../../../../support/tokens.js";
import { randomUUID } from "crypto";
import {
  DATA_READ,
  FILE_SOURCES_WRITE,
  SOURCES_READ,
  SOURCES_WRITE,
} from "../../../../../definitions/tereoDeclaration.js";
import {
  createFileSource,
  csvOf,
  fileSourcesCall,
  removeFileSourcesOf,
  schemaExists,
} from "../../../../support/fileSources.js";

const ownerId = randomUUID();
const owner = tokenFor({
  userId: ownerId,
  permissions: [DATA_READ, FILE_SOURCES_WRITE],
});
const otherId = randomUUID();
const other = tokenFor({
  userId: otherId,
  permissions: [DATA_READ, FILE_SOURCES_WRITE],
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
// The owner without the permission to manage file sources.
const demoted = tokenFor({ userId: ownerId, permissions: [DATA_READ] });

const CSV = csvOf(
  ["id", "name"],
  [
    ["1", "a"],
    ["2", "b"],
  ]
);

let app: Awaited<ReturnType<typeof startV1Routes>>;
const call = (method: string, path: string, token: string, body?: unknown) =>
  fileSourcesCall(app.url, method, path, token, body);
const make = () => createFileSource(app.url, owner, ownerId, CSV);

beforeAll(async () => {
  app = await startV1Routes();
});
afterAll(async () => {
  await removeRunsOf([ownerId, otherId, adminId]);
  await removeFileSourcesOf([ownerId, otherId, adminId]);
  await app.close();
});

describe("/v1/file-sources/:sourceId", () => {
  it("GET shows the source to its owner and to an admin", async () => {
    const source = await make();
    for (const token of [owner, admin, reader]) {
      const res = await call("GET", `/${source.id}`, token);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(source);
    }
  });

  it.each([
    ["GET", undefined],
    ["PATCH", { name: "Mine now" }],
    ["DELETE", undefined],
  ])(
    "%s answers 404 file_source_not_found to anyone else and for an unknown id",
    async (method, body) => {
      const source = await make();
      const res = await call(method, `/${source.id}`, other, body);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("file_source_not_found");
      // Without the permission at all, refused before any source is looked at.
      const demotedRes = await call(method, `/${source.id}`, demoted, body);
      expect(demotedRes.status).toBe(403);
      const missing = await call(method, `/${randomUUID()}`, owner, body);
      expect(missing.status).toBe(404);
      expect(missing.body.error).toBe("file_source_not_found");
      expect(await schemaExists(source.id)).toBe(true);
    }
  );

  it("PATCH and DELETE answer 404 to an admin who may only read", async () => {
    const source = await make();
    const res = await call("PATCH", `/${source.id}`, reader, { name: "x" });
    expect(res.status).toBe(404);
    expect((await call("DELETE", `/${source.id}`, reader)).status).toBe(404);
  });

  it("PATCH renames it, for the owner or an admin", async () => {
    const source = await make();
    const res = await call("PATCH", `/${source.id}`, owner, {
      name: "Renamed",
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: source.id, name: "Renamed" });
    const byAdmin = await call("PATCH", `/${source.id}`, admin, {
      name: "By admin",
    });
    expect(byAdmin.body.name).toBe("By admin");
    const bad = await call("PATCH", `/${source.id}`, owner, { slug: "x" });
    expect(bad.status).toBe(400);
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
    expect(view.body.tables[0].missing).toBe(true);
    expect(view.body.stored_bytes).toBe(0);
    const again = await call("DELETE", `/${source.id}`, owner);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("source_archived");
    // An archived one is not listed.
    const list = await call("GET", "", owner);
    expect(list.body.data.map((s: { id: string }) => s.id)).not.toContain(
      source.id
    );
  });

  it("DELETE by an admin works on anyone's source", async () => {
    const source = await make();
    expect((await call("DELETE", `/${source.id}`, admin)).status).toBe(204);
    expect(await schemaExists(source.id)).toBe(false);
  });
});
