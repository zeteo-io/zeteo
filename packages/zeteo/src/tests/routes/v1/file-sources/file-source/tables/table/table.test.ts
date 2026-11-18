// @module-tag int
// @module-tag platform
import { LOAD_LOCKING } from "../../../../../../../file-sources/service.js";
import { schemaFor } from "../../../../../../../file-sources/storage.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startV1Routes } from "../../../../../../support/v1App.js";
import { prisma } from "../../../../../../../utils/db/prisma.js";
import { tokenFor } from "../../../../../../support/tokens.js";
import { redis } from "../../../../../../../utils/redis.js";
import { randomUUID } from "crypto";
import {
  DATA_READ,
  FILE_SOURCES_WRITE,
} from "../../../../../../../definitions/tereoDeclaration.js";
import {
  createFileSource,
  csvOf,
  fileSourcesCall,
  removeFileSourcesOf,
  stageFile,
  storedTables,
} from "../../../../../../support/fileSources.js";
import {
  newQueryUser,
  postQuery,
  removeRunsOf,
} from "../../../../../../support/queries.js";

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
  fileSourcesCall(app.url, method, path, token, body);
const users: string[] = [];

beforeAll(async () => {
  app = await startV1Routes();
});
afterAll(async () => {
  await removeRunsOf([ownerId, ...users]);
  await removeFileSourcesOf([ownerId, otherId]);
  await app.close();
});

const columnsOf = (body: {
  tables: {
    columns: { id: string; name: string; type: string; missing: boolean }[];
  }[];
}) =>
  Object.fromEntries(
    body.tables[0]!.columns.map((c) => [c.name, [c.id, c.type, c.missing]])
  );

describe("PUT /v1/file-sources/:sourceId/tables/:tableId", () => {
  it("replaces the data, keeping column ids and grants, adding and marking missing", async () => {
    const source = await createFileSource(app.url, owner, ownerId, FIRST);
    const table = source.tables[0]!;
    const before = columnsOf(source);
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
    const after = columnsOf(res.body);
    expect(after.id).toEqual([before.id![0], "number", false]);
    expect(after.name).toEqual([before.name![0], "text", false]);
    expect(after.old).toEqual([before.old![0], "text", true]);
    expect(after.added).toEqual([expect.any(String), "boolean", false]);
    expect(res.body.tables[0].id).toBe(table.id);
    expect(res.body.tables[0].row_count).toBe(3);
    expect(Date.parse(res.body.tables[0].last_synced_at)).toBeGreaterThan(
      Date.parse(table.last_synced_at!) - 1
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
    const source = await createFileSource(app.url, owner, ownerId, FIRST);
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
    expect((await call("GET", `/${source.id}`, owner)).body).toEqual(source);
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
    expect(columnsOf(retyped.body).id).toEqual([
      columnsOf(source).id![0],
      "text",
      false,
    ]);
  });

  it("answers 503 file_source_busy while another load holds the source", async () => {
    const source = await createFileSource(app.url, owner, ownerId, FIRST);
    const wait = LOAD_LOCKING.lockWaitMs;
    LOAD_LOCKING.lockWaitMs = 300;
    await redis.set(`zeteo:file-source-load:${source.id}`, "someone", "EX", 60);
    try {
      const res = await call(
        "PUT",
        `/${source.id}/tables/${source.tables[0]!.id}`,
        owner,
        { staging_id: (await stageFile(ownerId, SECOND)).stagingId, key: "csv" }
      );
      expect(res.status).toBe(503);
      expect(res.body.error).toBe("file_source_busy");
    } finally {
      LOAD_LOCKING.lockWaitMs = wait;
      await redis.del(`zeteo:file-source-load:${source.id}`);
    }
  });

  it("answers 503 file_source_busy when a reader holds the table past the swap's lock wait, and changes nothing", async () => {
    const source = await createFileSource(app.url, owner, ownerId, FIRST);
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
      expect(res.body.error).toBe("file_source_busy");
    } finally {
      release();
      await holder;
      LOAD_LOCKING.swapLockTimeoutMs = timeout;
    }
    expect(await storedTables(source.id)).toEqual(["data"]);
    expect((await call("GET", `/${source.id}`, owner)).body).toEqual(source);
  });

  it("answers 404 to someone else, and for a table of another source", async () => {
    const source = await createFileSource(app.url, owner, ownerId, FIRST);
    const staged = await stageFile(otherId, SECOND);
    const theirs = await call(
      "PUT",
      `/${source.id}/tables/${source.tables[0]!.id}`,
      other,
      { staging_id: staged.stagingId, key: "csv" }
    );
    expect(theirs.status).toBe(404);
    const second = await createFileSource(app.url, owner, ownerId, FIRST);
    const wrong = await call(
      "PUT",
      `/${source.id}/tables/${second.tables[0]!.id}`,
      owner,
      { staging_id: (await stageFile(ownerId, SECOND)).stagingId, key: "csv" }
    );
    expect(wrong.status).toBe(404);
  });
});

describe("DELETE /v1/file-sources/:sourceId/tables/:tableId", () => {
  it("drops the table and marks it and its columns missing", async () => {
    const source = await createFileSource(app.url, owner, ownerId, FIRST);
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
