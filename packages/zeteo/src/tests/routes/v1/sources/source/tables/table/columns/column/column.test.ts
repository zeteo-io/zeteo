// @module-tag int
// @module-tag platform
import { removeSources } from "../../../../../../../../support/sources.js";
import { registerSource } from "../../../../../../../../support/grants.js";
import { startV1Routes } from "../../../../../../../../support/v1App.js";
import { prisma } from "../../../../../../../../../utils/db/prisma.js";
import { tokenFor } from "../../../../../../../../support/tokens.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import {
  DATA_READ,
  UPLOADS_WRITE,
  SOURCES_WRITE,
} from "../../../../../../../../../definitions/tereoDeclaration.js";
import {
  createUploadSource,
  csvOf,
  uploadTablesOf,
  removeUploadSourcesOf,
  sourcesCall,
  storedTables,
} from "../../../../../../../../support/uploads.js";
import {
  postQuery,
  removeRunsOf,
} from "../../../../../../../../support/queries.js";

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

const CSV = csvOf(
  ["id", "amount", "day", "at", "flag", "note"],
  [
    ["1", "10.50", "2026-01-02", "2026-01-02T10:00:00Z", "true", "x"],
    ["2", "-3", "2026-02-03", "2026-02-03T11:30:00+02:00", "false", "y"],
    ["3", "", "", "", "", ""],
  ]
);

let app: Awaited<ReturnType<typeof startV1Routes>>;
const call = (method: string, path: string, token: string, body?: unknown) =>
  sourcesCall(app.url, method, path, token, body);
let databaseSourceId: string;

beforeAll(async () => {
  app = await startV1Routes();
  databaseSourceId = await registerSource(app.url);
});
afterAll(async () => {
  await removeRunsOf([ownerId]);
  await removeUploadSourcesOf([ownerId, otherId]);
  await removeSources([databaseSourceId]);
  await app.close();
});

/** The source as `createUploadSource` gives it: its view, and its tables. */
const stateOf = async (id: string) => ({
  ...(await call("GET", `/${id}`, owner)).body,
  tables: await uploadTablesOf(id),
});

const columnPath = (
  source: {
    id: string;
    tables: { id: string; columns: { id: string; name: string }[] }[];
  },
  name: string
) => {
  const table = source.tables[0]!;
  const column = table.columns.find((c) => c.name === name)!;
  return `/${source.id}/tables/${table.id}/columns/${column.id}`;
};

const rowsOf = async (slug: string, select: string[]) =>
  (
    await postQuery(
      owner,
      { source: slug, from: "data", select, orderBy: [{ id: "asc" }] },
      app.url
    )
  ).body.rows;

describe("PATCH /v1/sources/:sourceId/tables/:tableId/columns/:columnId", () => {
  it("round-trips every type through text and back", async () => {
    const source = await createUploadSource(app.url, owner, ownerId, CSV);
    const select = ["amount", "day", "at", "flag"];
    const before = await rowsOf(source.slug, select);
    expect(before[0]).toEqual([
      "10.50",
      "2026-01-02",
      "2026-01-02T10:00:00.000Z",
      true,
    ]);
    const types: Record<string, string> = {
      amount: "number",
      day: "date",
      at: "timestamp",
      flag: "boolean",
    };
    for (const name of select) {
      const path = columnPath(source, name);
      const text = await call("PATCH", path, owner, { type: "text" });
      expect(text.status, JSON.stringify(text.body)).toBe(200);
      const back = await call("PATCH", path, owner, { type: types[name] });
      expect(back.status, JSON.stringify(back.body)).toBe(200);
    }
    expect(await rowsOf(source.slug, select)).toEqual(before);
    // Ids stay.
    const tables = await uploadTablesOf(source.id);
    expect(tables[0]!.columns.map((c) => c.id)).toEqual(
      source.tables[0]!.columns.map((c) => c.id)
    );
    expect(await storedTables(source.id)).toEqual(["data"]);
  });

  it("answers 422 cast_failed for a value that does not fit, and changes nothing", async () => {
    const source = await createUploadSource(app.url, owner, ownerId, CSV);
    const res = await call("PATCH", columnPath(source, "note"), owner, {
      type: "number",
    });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      error: "cast_failed",
      table: "data",
      column: "note",
      rows: [1, 2],
    });
    expect(await stateOf(source.id)).toEqual(source);
    expect(await storedTables(source.id)).toEqual(["data"]);
  });

  it("numbers a retype's failing rows as 1-based data rows of the table, the header not counted", async () => {
    const source = await createUploadSource(
      app.url,
      owner,
      ownerId,
      csvOf(["code"], [["5"], ["x"], ["7"], ["y"]])
    );
    // "x" and "y", the second and fourth data rows (rows 3 and 5 of the
    // file), are not numbers.
    const res = await call("PATCH", columnPath(source, "code"), owner, {
      type: "number",
    });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      error: "cast_failed",
      table: "data",
      column: "code",
      rows: [2, 4],
    });
  });

  it("renames a column keeping its id and grants, and sets a description", async () => {
    const source = await createUploadSource(app.url, owner, ownerId, CSV);
    const path = columnPath(source, "note");
    const res = await call("PATCH", path, owner, {
      name: "remark",
      description: "What was said",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ id: source.id, type: "upload" });
    const column = (await uploadTablesOf(source.id))[0]!.columns.find(
      (c) => c.name === "remark"
    )!;
    expect(column).toMatchObject({
      id: path.split("/").at(-1),
      original_name: "note",
      description: "What was said",
      type: "text",
    });
    expect(await rowsOf(source.slug, ["remark"])).toEqual([
      ["x"],
      ["y"],
      [null],
    ]);
    const taken = await call("PATCH", path, owner, { name: "id" });
    expect(taken.status).toBe(409);
    expect(taken.body.error).toBe("name_taken");
    const described = await call("PATCH", path, owner, { description: null });
    expect(described.status).toBe(200);
    expect(
      (
        await prisma.sourceColumn.findUniqueOrThrow({
          where: { id: column.id },
        })
      ).description
    ).toBeNull();
  });

  it("answers someone else as it answers anyone without the permission", async () => {
    const source = await createUploadSource(app.url, owner, ownerId, CSV);
    const path = columnPath(source, "note");
    const res = await call("PATCH", path, other, { type: "text" });
    expect(res.status).toBe(403);
    expect(bodyOf(res)).toEqual(
      bodyOf(await call("PATCH", path, nobody, { type: "text" }))
    );
  });

  it("answers 409 not_an_upload_source on a database source", async () => {
    const table = await prisma.sourceTable.findFirstOrThrow({
      where: { sourceId: databaseSourceId },
      include: { columns: true },
    });
    const res = await call(
      "PATCH",
      `/${databaseSourceId}/tables/${table.id}/columns/${table.columns[0]!.id}`,
      admin,
      { description: "Not here" }
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_an_upload_source");
  });
});
