// @module-tag int
// @module-tag platform
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startV1Routes } from "../../../support/v1App.js";
import { auditRows } from "../../../support/sources.js";
import { tokenFor } from "../../../support/tokens.js";
import { randomUUID } from "crypto";
import {
  DATA_READ,
  FILE_SOURCES_WRITE,
} from "../../../../definitions/tereoDeclaration.js";
import {
  csvOf,
  fileTablesOf,
  removeFileSourcesOf,
  sourcesCall,
  stageFile,
} from "../../../support/fileSources.js";
import {
  addUserToDirectory,
  clearDirectory,
} from "../../../support/principals.js";

const ownerId = randomUUID();
const owner = tokenFor({
  userId: ownerId,
  permissions: [DATA_READ, FILE_SOURCES_WRITE],
});
const nextId = randomUUID();

// Cell values that must never reach an audit entry.
const SECRET = "cell-secret-7f3a";
const csv = (n: number) =>
  csvOf(
    ["id", "secret"],
    Array.from({ length: n }, (_, i) => [String(i + 1), `${SECRET}-${i}`])
  );

let app: Awaited<ReturnType<typeof startV1Routes>>;
const call = (method: string, path: string, body?: unknown) =>
  sourcesCall(app.url, method, path, owner, body);

beforeAll(async () => {
  app = await startV1Routes();
  await addUserToDirectory(nextId);
});
afterAll(async () => {
  await clearDirectory();
  await removeFileSourcesOf([ownerId, nextId]);
  await app.close();
});

describe("/v1/sources audit (upload)", () => {
  it("records an entry for each change, never with cell data", async () => {
    const created = await call("POST", "", {
      type: "upload",
      staging_id: (await stageFile(ownerId, csv(2))).stagingId,
      name: "Audited",
      tables: [{ key: "csv", name: "secrets" }],
    });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const table = (await fileTablesOf(id))[0]!;
    const column = table.columns[1]!;

    const steps: [string, string, unknown][] = [
      ["PATCH", `/${id}`, { name: "Renamed" }],
      [
        "POST",
        `/${id}/tables`,
        {
          staging_id: (await stageFile(ownerId, csv(1))).stagingId,
          tables: [{ key: "csv", name: "more" }],
        },
      ],
      [
        "PUT",
        `/${id}/tables/${table.id}`,
        {
          staging_id: (await stageFile(ownerId, csv(3))).stagingId,
          key: "csv",
        },
      ],
      [
        "PATCH",
        `/${id}/tables/${table.id}/columns/${column.id}`,
        { name: "hidden", description: "Not data" },
      ],
    ];
    for (const [method, path, body] of steps) {
      const res = await call(method, path, body);
      expect(res.status, `${method} ${path}`).toBeLessThan(300);
    }
    const more = (await fileTablesOf(id)).find((t) => t.name === "more")!;
    expect((await call("DELETE", `/${id}/tables/${more.id}`)).status).toBe(204);
    expect(
      (await call("POST", `/${id}/transfer`, { user_id: nextId })).status
    ).toBe(200);
    const nextToken = tokenFor({
      userId: nextId,
      permissions: [DATA_READ, FILE_SOURCES_WRITE],
    });
    expect(
      (await sourcesCall(app.url, "DELETE", `/${id}`, nextToken)).status
    ).toBe(204);

    const entries = (await auditRows(id)).map((r) => r.payload);
    expect(entries.map((e) => [e.action, e.metadata.event])).toEqual([
      ["CREATE", "zeteo.file_source.created"],
      ["UPDATE", "zeteo.file_source.updated"],
      ["UPDATE", "zeteo.file_source.updated"],
      ["UPDATE", "zeteo.file_source.reuploaded"],
      ["UPDATE", "zeteo.file_source.updated"],
      ["UPDATE", "zeteo.file_source.updated"],
      ["UPDATE", "zeteo.file_source.transferred"],
      ["DELETE", "zeteo.file_source.deleted"],
    ]);
    expect(entries.at(-1)!.userId).toBe(nextId);
    expect(entries[0]!.metadata.owner_grant).toEqual({
      user_id: ownerId,
      table_ids: [table.id],
    });
    expect(entries[2]!.metadata.owner_grant).toEqual({
      user_id: ownerId,
      table_ids: [more.id],
    });
    expect(entries[6]!.metadata).toMatchObject({
      from: ownerId,
      to: nextId,
      keep_access: true,
      owner_grant: { user_id: nextId },
      grants_removed: [],
    });
    expect(JSON.stringify(entries)).not.toContain(SECRET);
    expect(JSON.stringify(entries)).not.toContain("Not data");
  });
});
