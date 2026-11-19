// @module-tag int
// @module-tag platform
import { auditRows, removeSources } from "../../../../../support/sources.js";
import { postQuery, removeRunsOf } from "../../../../../support/queries.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerSource } from "../../../../../support/grants.js";
import { startV1Routes } from "../../../../../support/v1App.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { tokenFor } from "../../../../../support/tokens.js";
import env from "../../../../../../env.js";
import { randomUUID } from "crypto";
import {
  DATA_READ,
  MEASURES_WRITE,
  UPLOADS_WRITE,
  SOURCES_READ,
  SOURCES_WRITE,
} from "../../../../../../definitions/tereoDeclaration.js";
import {
  addToDirectory,
  addUserToDirectory,
  clearDirectory,
} from "../../../../../support/principals.js";
import {
  createUploadSource,
  csvOf,
  removeUploadSourcesOf,
  sourcesCall,
} from "../../../../../support/uploads.js";

const userToken = (id: string) =>
  tokenFor({ userId: id, permissions: [DATA_READ, UPLOADS_WRITE] });
const adminId = randomUUID();
const admin = tokenFor({
  userId: adminId,
  permissions: [DATA_READ, SOURCES_READ, SOURCES_WRITE],
});
const CSV = csvOf(["id"], [["1"]]);

let app: Awaited<ReturnType<typeof startV1Routes>>;
const call = (method: string, path: string, token: string, body?: unknown) =>
  sourcesCall(app.url, method, path, token, body);
const users: string[] = [];
const user = async () => {
  const id = randomUUID();
  users.push(id);
  await addUserToDirectory(id);
  return { id, token: userToken(id) };
};
const grantsOn = (tableId: string) =>
  prisma.grant.findMany({
    where: { tableId },
    orderBy: { principalId: "asc" },
  });

let databaseSourceId: string;

beforeAll(async () => {
  app = await startV1Routes();
  databaseSourceId = await registerSource(app.url);
});
afterAll(async () => {
  await clearDirectory();
  await removeRunsOf(users);
  await removeUploadSourcesOf(users);
  await removeSources([databaseSourceId]);
  await app.close();
});

describe("POST /v1/sources/:sourceId/transfer", () => {
  it("moves the owner grant; the previous owner keeps a plain grant", async () => {
    const from = await user();
    const to = await user();
    const source = await createUploadSource(app.url, from.token, from.id, CSV);
    const tableId = source.tables[0]!.id;
    const res = await call("POST", `/${source.id}/transfer`, from.token, {
      user_id: to.id,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.owner_id).toBe(to.id);
    const grants = await grantsOn(tableId);
    const byId = new Map(
      grants.map((g) => [g.principalId, [g.allColumns, g.ownerGrant]])
    );
    expect(grants).toHaveLength(2);
    expect(byId.get(from.id)).toEqual([true, false]);
    expect(byId.get(to.id)).toEqual([true, true]);
    // The new owner manages it; the previous one no longer does.
    expect((await call("GET", `/${source.id}`, to.token)).status).toBe(200);
    expect((await call("GET", `/${source.id}`, from.token)).status).toBe(403);
    const q = { source: source.slug, from: "data", select: ["id"] };
    expect((await postQuery(from.token, q, app.url)).status).toBe(200);
    expect((await postQuery(to.token, q, app.url)).status).toBe(200);
  });

  it("with keep_access false, leaves the previous owner nothing", async () => {
    const from = await user();
    const to = await user();
    const source = await createUploadSource(app.url, from.token, from.id, CSV);
    const res = await call("POST", `/${source.id}/transfer`, from.token, {
      user_id: to.id,
      keep_access: false,
    });
    expect(res.status).toBe(200);
    expect(
      (await grantsOn(source.tables[0]!.id)).map((g) => g.principalId)
    ).toEqual([to.id]);
    const q = { source: source.slug, from: "data", select: ["id"] };
    expect((await postQuery(from.token, q, app.url)).status).toBe(422);
  });

  it("turns a grant the new owner had into the owner grant", async () => {
    const from = await user();
    const to = await user();
    const source = await createUploadSource(app.url, from.token, from.id, CSV);
    const tableId = source.tables[0]!.id;
    await prisma.grant.create({
      data: {
        principalType: "user",
        principalId: to.id,
        tableId,
        allColumns: false,
        createdBy: from.id,
        columns: { create: [{ columnId: source.tables[0]!.columns[0]!.id }] },
      },
    });
    const res = await call("POST", `/${source.id}/transfer`, admin, {
      user_id: to.id,
    });
    expect(res.status).toBe(200);
    const mine = (await grantsOn(tableId)).find((g) => g.principalId === to.id);
    expect(mine).toMatchObject({ allColumns: true, ownerGrant: true });
    expect(
      await prisma.grantColumn.count({ where: { grantId: mine!.id } })
    ).toBe(0);
  });

  it("refuses a service account, an unknown user and the owner, changing nothing", async () => {
    const from = await user();
    const robot = randomUUID();
    users.push(robot);
    await addToDirectory([
      {
        type: "user",
        id: robot,
        name: "Robot",
        email: "robot@example.com",
        status: "active",
        user_type: "service_account",
      },
    ]);
    const source = await createUploadSource(app.url, from.token, from.id, CSV);
    for (const target of [robot, randomUUID(), from.id]) {
      const res = await call("POST", `/${source.id}/transfer`, from.token, {
        user_id: target,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_transfer");
    }
    expect(
      (await prisma.source.findUniqueOrThrow({ where: { id: source.id } }))
        .ownerId
    ).toBe(from.id);
  });

  it("answers 409 quota_exceeded when the recipient would pass their quota, changing nothing", async () => {
    const from = await user();
    const to = await user();
    const theirs = await createUploadSource(app.url, to.token, to.id, CSV);
    const source = await createUploadSource(app.url, from.token, from.id, CSV);
    const quota = env.UPLOAD_QUOTA_BYTES;
    // Room for what the recipient has, not for one more.
    env.UPLOAD_QUOTA_BYTES = theirs.size_bytes + 1;
    try {
      const res = await call("POST", `/${source.id}/transfer`, admin, {
        user_id: to.id,
      });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("quota_exceeded");
    } finally {
      env.UPLOAD_QUOTA_BYTES = quota;
    }
    expect(
      (await prisma.source.findUniqueOrThrow({ where: { id: source.id } }))
        .ownerId
    ).toBe(from.id);
    expect(
      (await grantsOn(source.tables[0]!.id)).map((g) => [
        g.principalId,
        g.ownerGrant,
      ])
    ).toEqual([[from.id, true]]);
  });

  it("records the owner grant moved and the grants removed", async () => {
    const from = await user();
    const to = await user();
    const source = await createUploadSource(app.url, from.token, from.id, CSV);
    const tableId = source.tables[0]!.id;
    const [old] = await grantsOn(tableId);
    const res = await call("POST", `/${source.id}/transfer`, from.token, {
      user_id: to.id,
      keep_access: false,
    });
    expect(res.status).toBe(200);
    const entry = (await auditRows(source.id)).at(-1)!.payload;
    expect(entry.metadata).toMatchObject({
      event: "zeteo.source.transferred",
      type: "upload",
      owner_grant: { user_id: to.id, table_ids: [tableId] },
      grants_removed: [old!.id],
    });
  });

  it("answers someone else as it answers anyone without the permission", async () => {
    const from = await user();
    const stranger = await user();
    const source = await createUploadSource(app.url, from.token, from.id, CSV);
    const res = await call("POST", `/${source.id}/transfer`, stranger.token, {
      user_id: stranger.id,
    });
    expect(res.status).toBe(403);
    const nobody = tokenFor({ permissions: [] });
    const refused = await call("POST", `/${source.id}/transfer`, nobody, {
      user_id: stranger.id,
    });
    const { request_id: _a, ...one } = res.body;
    const { request_id: _b, ...two } = refused.body;
    expect(one).toEqual(two);
  });

  it("answers 409 not_an_upload_source for a database source", async () => {
    const to = await user();
    const res = await call("POST", `/${databaseSourceId}/transfer`, admin, {
      user_id: to.id,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_an_upload_source");
  });
  it("keeps the measure editors; the new owner edits measures, the previous one only if listed", async () => {
    const from = await user();
    const to = await user();
    const listed = randomUUID();
    const editorToken = (id: string) =>
      tokenFor({
        userId: id,
        permissions: [DATA_READ, UPLOADS_WRITE, MEASURES_WRITE],
      });
    const source = await createUploadSource(
      app.url,
      from.token,
      from.id,
      csvOf(["id", "amount"], [["1", "5"]])
    );
    const put = await call(
      "PUT",
      `/${source.id}/measure-editors`,
      editorToken(from.id),
      { principals: [{ type: "user", id: listed }] }
    );
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const res = await call("POST", `/${source.id}/transfer`, from.token, {
      user_id: to.id,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const editors = await prisma.measureEditor.findMany({
      where: { sourceId: source.id },
    });
    expect(editors.map((e) => [e.principalType, e.principalId])).toEqual([
      ["user", listed],
    ]);
    const measure = (name: string) => ({
      name,
      description: `The ${name}`,
      table: "data",
      formula: { sum: "amount" },
    });
    const byNew = await call(
      "POST",
      `/${source.id}/measures`,
      editorToken(to.id),
      measure("by_new_owner")
    );
    expect(byNew.status, JSON.stringify(byNew.body)).toBe(201);
    const byPrevious = await call(
      "POST",
      `/${source.id}/measures`,
      editorToken(from.id),
      measure("by_previous_owner")
    );
    expect(byPrevious.status).toBe(403);
  });
});
