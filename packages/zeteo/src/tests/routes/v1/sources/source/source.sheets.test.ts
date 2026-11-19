// @module-tag int
// @module-tag platform
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stageSheets } from "../../../../../uploads/staging.js";
import { removeRunsOf } from "../../../../support/queries.js";
import { startV1Routes } from "../../../../support/v1App.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import { tokenFor } from "../../../../support/tokens.js";
import { fetchJson } from "../../../../support/http.js";
import { randomUUID } from "crypto";
import {
  DATA_READ,
  UPLOADS_WRITE,
  SOURCES_READ,
  SOURCES_WRITE,
} from "../../../../../definitions/tereoDeclaration.js";
import {
  auditRows,
  removeSources,
  sourceBody,
  sourceSettings,
} from "../../../../support/sources.js";
import {
  createUploadSource,
  csvOf,
  removeUploadSourcesOf,
  sourcesCall,
} from "../../../../support/uploads.js";

const ownerId = randomUUID();
const owner = tokenFor({
  userId: ownerId,
  permissions: [DATA_READ, UPLOADS_WRITE],
});
const granteeId = randomUUID();
const grantee = tokenFor({ userId: granteeId, permissions: [DATA_READ] });
const adminId = randomUUID();
const admin = tokenFor({
  userId: adminId,
  permissions: [DATA_READ, SOURCES_READ, SOURCES_WRITE],
});

const databaseSources: string[] = [];

let app: Awaited<ReturnType<typeof startV1Routes>>;
const call = (method: string, path: string, token: string, body?: unknown) =>
  sourcesCall(app.url, method, path, token, body);

beforeAll(async () => {
  app = await startV1Routes();
});
afterAll(async () => {
  await removeRunsOf([ownerId, granteeId, adminId]);
  await removeUploadSourcesOf([ownerId, granteeId, adminId]);
  await removeSources(databaseSources);
  await app.close();
});

const makeSheets = async () => {
  const sheet = `sheet-${randomUUID()}`;
  const staged = await stageSheets({
    ownerId,
    spreadsheet: {
      id: sheet,
      title: "Book",
      tabs: [{ sheetId: 7, name: "Data", kind: "sheet", rows: [["A"], ["1"]] }],
    },
  });
  const res = await call("POST", "", owner, {
    type: "upload",
    staging_id: staged.stagingId,
    name: "Book",
    tables: [{ key: "sheet:7" }],
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { sheet, source: res.body };
};

describe("PATCH /v1/sources/:id sync_interval_minutes", () => {
  it("15 ok, 14 and 1441 are 400", async () => {
    const { source } = await makeSheets();
    const ok = await call("PATCH", `/${source.id}`, owner, {
      sync_interval_minutes: 15,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.sync.interval_minutes).toBe(15);
    const adminOk = await call("PATCH", `/${source.id}`, admin, {
      sync_interval_minutes: 30,
    });
    expect(adminOk.status).toBe(200);
    for (const bad of [14, 1441]) {
      const res = await call("PATCH", `/${source.id}`, owner, {
        sync_interval_minutes: bad,
      });
      expect(res.status).toBe(400);
    }
  });

  it("PATCH sync_interval_minutes on a file-only upload source is accepted", async () => {
    const file = await createUploadSource(
      app.url,
      owner,
      ownerId,
      csvOf(["a"], [["1"]])
    );
    const res = await call("PATCH", `/${file.id}`, owner, {
      sync_interval_minutes: 15,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).not.toHaveProperty("sync");
    const adminRes = await call("PATCH", `/${file.id}`, admin, {
      row_cap: 500,
      sync_interval_minutes: 45,
    });
    expect(adminRes.status, JSON.stringify(adminRes.body)).toBe(200);
    const row = await prisma.source.findUniqueOrThrow({
      where: { id: file.id },
    });
    expect(row.syncIntervalMinutes).toBe(45);
  });
});

describe("PATCH /v1/sources/:id by an admin, with limits and sync_interval_minutes", () => {
  it("on a Sheets source applies both, in one audit entry", async () => {
    const { source } = await makeSheets();
    const before = (await auditRows(source.id)).length;
    const res = await call("PATCH", `/${source.id}`, admin, {
      row_cap: 500,
      sync_interval_minutes: 30,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.row_cap).toBe(500);
    expect(res.body.sync.interval_minutes).toBe(30);
    const row = await prisma.source.findUniqueOrThrow({
      where: { id: source.id },
    });
    expect(row).toMatchObject({ rowCap: 500, syncIntervalMinutes: 30 });
    const entries = (await auditRows(source.id)).slice(before);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.payload).toMatchObject({
      metadata: {
        event: "zeteo.source.updated",
        changed: expect.arrayContaining(["row_cap", "sync_interval_minutes"]),
      },
    });
  });

  it("on a database source is 422 not_synced", async () => {
    const created = await fetchJson(
      "POST",
      `${app.url}/v1/sources`,
      admin,
      sourceBody(sourceSettings("ro"))
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    databaseSources.push(created.body.id);
    const res = await call("PATCH", `/${created.body.id}`, admin, {
      row_cap: 500,
      sync_interval_minutes: 30,
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("not_synced");
  });
});

describe("sync and origins in the view", () => {
  it("appear for the owner and admins, not in a grantee's catalogue", async () => {
    const { sheet, source } = await makeSheets();
    expect(source).not.toHaveProperty("sheet");
    const tables = await call("GET", `/${source.id}/tables`, owner);
    expect(tables.status, JSON.stringify(tables.body)).toBe(200);
    expect(tables.body.data[0].origin).toEqual({
      kind: "google-sheets",
      spreadsheetId: sheet,
      spreadsheetTitle: "Book",
      sheetId: 7,
      headerRow: 0,
    });
    const expected = {
      sync: {
        interval_minutes: 60,
        last_attempt_at: expect.any(String),
        last_error: null,
        stale: false,
      },
    };
    expect(source).toMatchObject(expected);
    const asAdmin = await call("GET", `/${source.id}`, admin);
    expect(asAdmin.body).toMatchObject(expected);

    // A failed sync more than a day after the last good one is stale.
    await prisma.source.update({
      where: { id: source.id },
      data: {
        lastSyncError: { code: "sheet_unreachable", message: "Gone" },
        lastRefreshedAt: new Date(Date.now() - 25 * 3600_000),
      },
    });
    const stale = await call("GET", `/${source.id}`, owner);
    expect(stale.body.sync).toMatchObject({
      last_error: { code: "sheet_unreachable", message: "Gone" },
      stale: true,
    });
    expect(stale.body.last_refreshed_at).toBeTruthy();

    const table = await prisma.sourceTable.findFirstOrThrow({
      where: { sourceId: source.id },
    });
    await prisma.grant.create({
      data: {
        principalType: "user",
        principalId: granteeId,
        tableId: table.id,
        allColumns: true,
        createdBy: ownerId,
      },
    });
    const catalog = await fetchJson("GET", `${app.url}/v1/catalog`, grantee);
    expect(catalog.status).toBe(200);
    const text = JSON.stringify(catalog.body);
    expect(text).not.toContain(sheet);
    expect(text).not.toContain("interval_minutes");
    expect(text).not.toContain("sheet_unreachable");
    const forbidden = await call("GET", `/${source.id}`, grantee);
    expect(forbidden.status).toBe(403);
  });
});
