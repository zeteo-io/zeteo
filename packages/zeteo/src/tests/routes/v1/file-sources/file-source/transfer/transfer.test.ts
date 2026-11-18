// @module-tag int
// @module-tag platform
import { postQuery, removeRunsOf } from "../../../../../support/queries.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startV1Routes } from "../../../../../support/v1App.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { tokenFor } from "../../../../../support/tokens.js";
import { randomUUID } from "crypto";
import {
  DATA_READ,
  FILE_SOURCES_WRITE,
  SOURCES_READ,
  SOURCES_WRITE,
} from "../../../../../../definitions/tereoDeclaration.js";
import {
  createFileSource,
  csvOf,
  fileSourcesCall,
  removeFileSourcesOf,
} from "../../../../../support/fileSources.js";
import {
  addToDirectory,
  addUserToDirectory,
  clearDirectory,
} from "../../../../../support/principals.js";

const userToken = (id: string) =>
  tokenFor({ userId: id, permissions: [DATA_READ, FILE_SOURCES_WRITE] });
const adminId = randomUUID();
const admin = tokenFor({
  userId: adminId,
  permissions: [DATA_READ, SOURCES_READ, SOURCES_WRITE],
});
const CSV = csvOf(["id"], [["1"]]);

let app: Awaited<ReturnType<typeof startV1Routes>>;
const call = (method: string, path: string, token: string, body?: unknown) =>
  fileSourcesCall(app.url, method, path, token, body);
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

beforeAll(async () => {
  app = await startV1Routes();
});
afterAll(async () => {
  await clearDirectory();
  await removeRunsOf(users);
  await removeFileSourcesOf(users);
  await app.close();
});

describe("POST /v1/file-sources/:sourceId/transfer", () => {
  it("moves the owner grant; the previous owner keeps a plain grant", async () => {
    const from = await user();
    const to = await user();
    const source = await createFileSource(app.url, from.token, from.id, CSV);
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
    expect((await call("GET", `/${source.id}`, from.token)).status).toBe(404);
    const q = { source: source.slug, from: "data", select: ["id"] };
    expect((await postQuery(from.token, q, app.url)).status).toBe(200);
    expect((await postQuery(to.token, q, app.url)).status).toBe(200);
  });

  it("with keep_access false, leaves the previous owner nothing", async () => {
    const from = await user();
    const to = await user();
    const source = await createFileSource(app.url, from.token, from.id, CSV);
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
    const source = await createFileSource(app.url, from.token, from.id, CSV);
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
    const source = await createFileSource(app.url, from.token, from.id, CSV);
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

  it("answers 404 to someone else", async () => {
    const from = await user();
    const stranger = await user();
    const source = await createFileSource(app.url, from.token, from.id, CSV);
    const res = await call("POST", `/${source.id}/transfer`, stranger.token, {
      user_id: stranger.id,
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("file_source_not_found");
  });
});
