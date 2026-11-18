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
  stageFile,
  storedTables,
} from "../../../../../support/fileSources.js";

const ownerId = randomUUID();
const owner = tokenFor({
  userId: ownerId,
  permissions: [DATA_READ, FILE_SOURCES_WRITE],
});
const adminId = randomUUID();
const admin = tokenFor({
  userId: adminId,
  permissions: [DATA_READ, FILE_SOURCES_WRITE, SOURCES_READ, SOURCES_WRITE],
});
const otherId = randomUUID();
const other = tokenFor({
  userId: otherId,
  permissions: [DATA_READ, FILE_SOURCES_WRITE],
});

const CSV = csvOf(["id", "name"], [["1", "a"]]);
const MORE = csvOf(
  ["code", "label"],
  [
    ["x", "X"],
    ["y", "Y"],
  ]
);

let app: Awaited<ReturnType<typeof startV1Routes>>;
const call = (method: string, path: string, token: string, body?: unknown) =>
  fileSourcesCall(app.url, method, path, token, body);

beforeAll(async () => {
  app = await startV1Routes();
});
afterAll(async () => {
  await removeRunsOf([ownerId]);
  await removeFileSourcesOf([ownerId, adminId, otherId]);
  await app.close();
});

describe("POST /v1/file-sources/:sourceId/tables", () => {
  it("adds tables from a staging, each with an owner grant", async () => {
    const source = await createFileSource(app.url, owner, ownerId, CSV);
    const staged = await stageFile(ownerId, MORE);
    const res = await call("POST", `/${source.id}/tables`, owner, {
      staging_id: staged.stagingId,
      tables: [{ key: "csv", name: "codes" }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.tables.map((t: { name: string }) => t.name)).toEqual([
      "codes",
      "data",
    ]);
    const codes = res.body.tables.find(
      (t: { name: string }) => t.name === "codes"
    );
    expect(codes.row_count).toBe(2);
    expect(await storedTables(source.id)).toEqual(["codes", "data"]);
    expect(
      await prisma.grant.findMany({ where: { tableId: codes.id } })
    ).toEqual([
      expect.objectContaining({ principalId: ownerId, ownerGrant: true }),
    ]);
    const q = await postQuery(
      owner,
      {
        source: source.slug,
        from: "codes",
        select: ["code"],
        orderBy: [{ code: "asc" }],
      },
      app.url
    );
    expect(q.body.rows).toEqual([["x"], ["y"]]);
  });

  it("gives an admin's added table to the owner, not the admin", async () => {
    const source = await createFileSource(app.url, owner, ownerId, CSV);
    const res = await call("POST", `/${source.id}/tables`, admin, {
      staging_id: (await stageFile(adminId, MORE)).stagingId,
      tables: [{ key: "csv", name: "codes" }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const codes = res.body.tables.find(
      (t: { name: string }) => t.name === "codes"
    );
    expect(
      (await prisma.grant.findMany({ where: { tableId: codes.id } })).map(
        (g) => g.principalId
      )
    ).toEqual([ownerId]);
  });

  it("answers 409 name_taken for a table name the source has", async () => {
    const source = await createFileSource(app.url, owner, ownerId, CSV);
    const res = await call("POST", `/${source.id}/tables`, owner, {
      staging_id: (await stageFile(ownerId, MORE)).stagingId,
      tables: [{ key: "csv", name: "data" }],
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("name_taken");
    expect(await storedTables(source.id)).toEqual(["data"]);
  });

  it("answers 404 to someone else", async () => {
    const source = await createFileSource(app.url, owner, ownerId, CSV);
    const res = await call("POST", `/${source.id}/tables`, other, {
      staging_id: (await stageFile(otherId, MORE)).stagingId,
      tables: [{ key: "csv", name: "codes" }],
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("file_source_not_found");
  });
});
