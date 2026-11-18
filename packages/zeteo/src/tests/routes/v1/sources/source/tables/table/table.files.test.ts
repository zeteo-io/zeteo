// @module-tag int
// @module-tag platform
import { LOAD_LOCKING } from "../../../../../../../uploads/service.js";
import { removeSources } from "../../../../../../support/sources.js";
import { registerSource } from "../../../../../../support/grants.js";
import { schemaFor } from "../../../../../../../uploads/storage.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startV1Routes } from "../../../../../../support/v1App.js";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import { tokenFor } from "../../../../../../support/tokens.js";
import { redis } from "../../../../../../../utils/redis.js";
import { randomUUID } from "crypto";
import {
  DATA_READ,
  UPLOADS_WRITE,
  SOURCES_WRITE,
} from "../../../../../../../definitions/tereoDeclaration.js";
import {
  createUploadSource,
  csvOf,
  uploadTablesOf,
  removeUploadSourcesOf,
  sourcesCall,
  type UploadTable,
  stageFile,
  storedTables,
} from "../../../../../../support/uploads.js";
import {
  newQueryUser,
  postQuery,
  removeRunsOf,
} from "../../../../../../support/queries.js";

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
const nobody = tokenFor({ permissions: [] });
const admin = tokenFor({ permissions: [DATA_READ, SOURCES_WRITE] });

const bodyOf = (res: { body: Record<string, unknown> }) => {
  const { request_id: _, ...rest } = res.body;
  return rest;
};

const FIRST = csvOf(
  ["id", "name", "old"],
  [
    ["1", "a", "x"],
    ["2", "b", "y"],
  ]
);
const SECOND = csvOf(
  ["name", "id", "added"],
  [
    ["c", "3", "true"],
    ["d", "4", "false"],
    ["e", "5", "true"],
  ]
);

let app: Awaited<ReturnType<typeof startV1Routes>>;
const call = (method: string, path: string, token: string, body?: unknown) =>
  sourcesCall(app.url, method, path, token, body);
const users: string[] = [];
let databaseSourceId: string;
let databaseTableId: string;

beforeAll(async () => {
  app = await startV1Routes();
  databaseSourceId = await registerSource(app.url);
  databaseTableId = (
    await prisma.sourceTable.findFirstOrThrow({
      where: { sourceId: databaseSourceId },
    })
  ).id;
});
afterAll(async () => {
  await removeRunsOf([ownerId, ...users]);
  await removeUploadSourcesOf([ownerId, otherId]);
  await removeSources([databaseSourceId]);
  await app.close();
});

const columnsOf = (tables: UploadTable[]) =>
  Object.fromEntries(
    tables[0]!.columns.map((c) => [c.name, [c.id, c.type, c.missing]])
  );

/** The source as `createUploadSource` gives it: its view, and its tables. */
const stateOf = async (id: string) => ({
  ...(await call("GET", `/${id}`, owner)).body,
  tables: await uploadTablesOf(id),
});

describe("PUT /v1/sources/:sourceId/tables/:tableId", () => {
  it("replaces the data, keeping column ids and grants, adding and marking missing", async () => {
    const source = await createUploadSource(app.url, owner, ownerId, FIRST);
    const table = source.tables[0]!;
    const before = columnsOf(source.tables);
    // A grant of one column to someone else.
    const user = newQueryUser();
    users.push(user.id);
    await prisma.grant.create({
      data: {
        principalType: "user",
        principalId: user.id,
        tableId: table.id,
        allColumns: false,
        createdBy: ownerId,
        columns: { create: [{ columnId: before.name![0] as string }] },
      },
    });

    const staged = await stageFile(ownerId, SECOND);
    const res = await call("PUT", `/${source.id}/tables/${table.id}`, owner, {
      staging_id: staged.stagingId,
      key: "csv",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ id: source.id, type: "upload" });
    const tables = await uploadTablesOf(source.id);
    const after = columnsOf(tables);
    expect(after.id).toEqual([before.id![0], "number", false]);
    expect(after.name).toEqual([before.name![0], "text", false]);
    expect(after.old).toEqual([before.old![0], "text", true]);
    expect(after.added).toEqual([expect.any(String), "boolean", false]);
    expect(tables[0]!.id).toBe(table.id);
    expect(tables[0]!.row_count).toBe(3);
    expect(Date.parse(tables[0]!.last_loaded_at!)).toBeGreaterThan(
      Date.parse(table.last_loaded_at!) - 1
    );
    expect(await storedTables(source.id)).toEqual(["data"]);

    const theirs = await postQuery(
      user.token,
      {
        source: source.slug,
        from: "data",
        select: ["name"],
        orderBy: [{ name: "asc" }],
      },
      app.url
    );
    expect(theirs.status, JSON.stringify(theirs.body)).toBe(200);
    expect(theirs.body.rows).toEqual([["c"], ["d"], ["e"]]);
    const mine = await postQuery(
      owner,
      {
        source: source.slug,
        from: "data",
        select: ["id", "added"],
        orderBy: [{ id: "asc" }],
      },
      app.url
    );
    expect(mine.body.rows).toEqual([
      ["3", true],
      ["4", false],
      ["5", true],
    ]);
  });

  it("keeps a matched column's type unless told otherwise, and fails to cast without changing anything", async () => {
    const source = await createUploadSource(app.url, owner, ownerId, FIRST);
    const table = source.tables[0]!;
    // `id` now holds text: its current type, number, does not fit.
    const bad = csvOf(["id", "name"], [["A1", "z"]]);
    const res = await call("PUT", `/${source.id}/tables/${table.id}`, owner, {
      staging_id: (await stageFile(ownerId, bad)).stagingId,
      key: "csv",
    });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      error: "cast_failed",
      table: "data",
      column: "id",
      rows: [2],
    });
    expect(await stateOf(source.id)).toEqual(source);
    expect(await storedTables(source.id)).toEqual(["data"]);

    const retyped = await call(
      "PUT",
      `/${source.id}/tables/${table.id}`,
      owner,
      {
        staging_id: (await stageFile(ownerId, bad)).stagingId,
        key: "csv",
        columns: [{ index: 0, type: "text" }],
      }
    );
    expect(retyped.status, JSON.stringify(retyped.body)).toBe(200);
    expect(columnsOf(await uploadTablesOf(source.id)).id).toEqual([
      columnsOf(source.tables).id![0],
      "text",
      false,
    ]);
  });

  it("answers 503 upload_source_busy while another load holds the source", async () => {
    const source = await createUploadSource(app.url, owner, ownerId, FIRST);
    const wait = LOAD_LOCKING.lockWaitMs;
    LOAD_LOCKING.lockWaitMs = 300;
    await redis.set(
      `zeteo:upload-source-load:${source.id}`,
      "someone",
      "EX",
      60
    );
    try {
      const res = await call(
        "PUT",
        `/${source.id}/tables/${source.tables[0]!.id}`,
        owner,
        { staging_id: (await stageFile(ownerId, SECOND)).stagingId, key: "csv" }
      );
      expect(res.status).toBe(503);
      expect(res.body.error).toBe("upload_source_busy");
    } finally {
      LOAD_LOCKING.lockWaitMs = wait;
      await redis.del(`zeteo:upload-source-load:${source.id}`);
    }
  });

  it("answers 503 upload_source_busy when a reader holds the table past the swap's lock wait, and changes nothing", async () => {
    const source = await createUploadSource(app.url, owner, ownerId, FIRST);
    const timeout = LOAD_LOCKING.swapLockTimeoutMs;
    LOAD_LOCKING.swapLockTimeoutMs = 300;
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          `LOCK TABLE "${schemaFor(source.id)}"."data" IN ACCESS SHARE MODE`
        );
        locked();
        await released;
      },
      { timeout: 30_000 }
    );
    try {
      await isLocked;
      const res = await call(
        "PUT",
        `/${source.id}/tables/${source.tables[0]!.id}`,
        owner,
        { staging_id: (await stageFile(ownerId, SECOND)).stagingId, key: "csv" }
      );
      expect(res.status).toBe(503);
      expect(res.body.error).toBe("upload_source_busy");
    } finally {
      release();
      await holder;
      LOAD_LOCKING.swapLockTimeoutMs = timeout;
    }
    expect(await storedTables(source.id)).toEqual(["data"]);
    expect(await stateOf(source.id)).toEqual(source);
  });

  it("answers 503 upload_source_busy when the swap runs out of time, and changes nothing", async () => {
    const source = await createUploadSource(app.url, owner, ownerId, FIRST);
    const timeout = LOAD_LOCKING.swapTimeoutMs;
    LOAD_LOCKING.swapTimeoutMs = 1;
    try {
      const res = await call(
        "PUT",
        `/${source.id}/tables/${source.tables[0]!.id}`,
        owner,
        { staging_id: (await stageFile(ownerId, SECOND)).stagingId, key: "csv" }
      );
      expect(res.status).toBe(503);
      expect(res.body.error).toBe("upload_source_busy");
    } finally {
      LOAD_LOCKING.swapTimeoutMs = timeout;
    }
    expect(await storedTables(source.id)).toEqual(["data"]);
    expect(await stateOf(source.id)).toEqual(source);
  });

  it("answers someone else as anyone without the permission, and 404 for a table of another source", async () => {
    const source = await createUploadSource(app.url, owner, ownerId, FIRST);
    const staged = await stageFile(otherId, SECOND);
    const theirs = await call(
      "PUT",
      `/${source.id}/tables/${source.tables[0]!.id}`,
      other,
      { staging_id: staged.stagingId, key: "csv" }
    );
    expect(theirs.status).toBe(403);
    expect(bodyOf(theirs)).toEqual(
      bodyOf(
        await call(
          "PUT",
          `/${source.id}/tables/${source.tables[0]!.id}`,
          nobody,
          { staging_id: staged.stagingId, key: "csv" }
        )
      )
    );
    const second = await createUploadSource(app.url, owner, ownerId, FIRST);
    const wrong = await call(
      "PUT",
      `/${source.id}/tables/${second.tables[0]!.id}`,
      owner,
      { staging_id: (await stageFile(ownerId, SECOND)).stagingId, key: "csv" }
    );
    expect(wrong.status).toBe(404);
  });
});

describe("DELETE /v1/sources/:sourceId/tables/:tableId", () => {
  it("drops the table and marks it and its columns missing", async () => {
    const source = await createUploadSource(app.url, owner, ownerId, FIRST);
    const table = source.tables[0]!;
    const res = await call("DELETE", `/${source.id}/tables/${table.id}`, owner);
    expect(res.status).toBe(204);
    expect(await storedTables(source.id)).toEqual([]);
    const row = await prisma.sourceTable.findUniqueOrThrow({
      where: { id: table.id },
      include: { columns: true },
    });
    expect(row.missingSince).not.toBeNull();
    expect(row.columns.every((c) => c.missingSince)).toBe(true);
    const q = await postQuery(
      owner,
      { source: source.slug, from: "data", select: ["id"] },
      app.url
    );
    // As for any table gone from its source.
    expect(q.status).toBe(422);
    expect(q.body.error).toBe("missing_in_source");
    const again = await call(
      "DELETE",
      `/${source.id}/tables/${table.id}`,
      owner
    );
    expect(again.status).toBe(404);
  });
});

describe("upload-only table routes on a database source", () => {
  it.each([
    ["PUT", { staging_id: "00000000-0000-4000-8000-000000000000", key: "csv" }],
    ["DELETE", undefined],
  ])("%s answers 409 not_an_upload_source", async (method, body) => {
    const res = await call(
      method,
      `/${databaseSourceId}/tables/${databaseTableId}`,
      admin,
      body
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_an_upload_source");
    expect(
      await prisma.sourceTable.findUniqueOrThrow({
        where: { id: databaseTableId },
      })
    ).toMatchObject({ missingSince: null });
  });
});
