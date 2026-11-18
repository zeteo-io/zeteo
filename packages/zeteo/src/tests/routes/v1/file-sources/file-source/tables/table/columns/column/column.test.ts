// @module-tag int
// @module-tag platform
import { startV1Routes } from "../../../../../../../../support/v1App.js";
import { prisma } from "../../../../../../../../../utils/db/prisma.js";
import { tokenFor } from "../../../../../../../../support/tokens.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import {
  DATA_READ,
  FILE_SOURCES_WRITE,
} from "../../../../../../../../../definitions/tereoDeclaration.js";
import {
  createFileSource,
  csvOf,
  fileSourcesCall,
  removeFileSourcesOf,
  storedTables,
} from "../../../../../../../../support/fileSources.js";
import {
  postQuery,
  removeRunsOf,
} from "../../../../../../../../support/queries.js";

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
  fileSourcesCall(app.url, method, path, token, body);

beforeAll(async () => {
  app = await startV1Routes();
});
afterAll(async () => {
  await removeRunsOf([ownerId]);
  await removeFileSourcesOf([ownerId, otherId]);
  await app.close();
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

describe("PATCH /v1/file-sources/:sourceId/tables/:tableId/columns/:columnId", () => {
  it("round-trips every type through text and back", async () => {
    const source = await createFileSource(app.url, owner, ownerId, CSV);
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
    const view = (await call("GET", `/${source.id}`, owner)).body;
    // Ids stay.
    expect(view.tables[0].columns.map((c: { id: string }) => c.id)).toEqual(
      source.tables[0]!.columns.map((c) => c.id)
    );
    expect(await storedTables(source.id)).toEqual(["data"]);
  });

  it("answers 422 cast_failed for a value that does not fit, and changes nothing", async () => {
    const source = await createFileSource(app.url, owner, ownerId, CSV);
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
    expect((await call("GET", `/${source.id}`, owner)).body).toEqual(source);
    expect(await storedTables(source.id)).toEqual(["data"]);
  });

  it("renames a column keeping its id and grants, and sets a description", async () => {
    const source = await createFileSource(app.url, owner, ownerId, CSV);
    const path = columnPath(source, "note");
    const res = await call("PATCH", path, owner, {
      name: "remark",
      description: "What was said",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const column = res.body.tables[0].columns.find(
      (c: { name: string }) => c.name === "remark"
    );
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

  it("answers 404 to someone else", async () => {
    const source = await createFileSource(app.url, owner, ownerId, CSV);
    const res = await call("PATCH", columnPath(source, "note"), other, {
      type: "text",
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("file_source_not_found");
  });
});
