// @module-tag int
// @module-tag platform
import { sealSettings } from "../../../../../../utils/crypto/envelope.js";
import { closeSourcePool } from "../../../../../../sources/pools.js";
import { LOAD_LOCKING } from "../../../../../../uploads/loading.js";
import { startV1Routes } from "../../../../../support/v1App.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { tokenFor } from "../../../../../support/tokens.js";
import { fetchJson } from "../../../../../support/http.js";
import { redis } from "../../../../../../utils/redis.js";
import { randomUUID } from "crypto";
import {
  DATA_READ,
  UPLOADS_WRITE,
} from "../../../../../../definitions/tereoDeclaration.js";
import {
  FakeSpreadsheet,
  serveSheets,
  stageFakeSheet,
} from "../../../../../support/googleSheets.js";
import {
  createUploadSource,
  csvOf,
  removeUploadSources,
  removeUploadSourcesOf,
  seedUploadSource,
} from "../../../../../support/uploads.js";
import {
  auditRows,
  readToken,
  removeSources,
  sourceBody,
  sourceSettings,
  writeToken,
} from "../../../../../support/sources.js";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const google = vi.hoisted(() => ({
  getSpreadsheet: vi.fn(),
  googleClient: vi.fn(),
}));

vi.mock("../../../../../../google/handler.js", () => ({
  googleClient: () => google.googleClient(),
  sheetsApi: {
    getSpreadsheet: (...args: unknown[]) => google.getSpreadsheet(...args),
  },
  stopGoogleHandler: vi.fn(),
}));

describe("POST /v1/sources/:sourceId/refresh", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  const created: string[] = [];

  const call = (method: string, path: string, token = writeToken()) =>
    fetchJson(method, `${app.url}/v1/sources${path}`, token);

  const newSource = async () => {
    const res = await fetchJson(
      "POST",
      `${app.url}/v1/sources`,
      writeToken(),
      sourceBody(sourceSettings("ro"), { schemas: ["sales"] })
    );
    created.push(res.body.id);
    return res.body.id as string;
  };

  beforeAll(async () => {
    app = await startV1Routes();
  });
  afterAll(async () => {
    await removeSources(created);
    await app.close();
  });

  it("answers the summary and records the refresh in the audit trail", async () => {
    const id = await newSource();
    const res = await call("POST", `/${id}/refresh`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      tables: { added: 0, missing: 0, restored: 0 },
      columns: { added: 0, changed: 0, missing: 0, restored: 0 },
      relations: { added: 0, missing: 0, restored: 0 },
    });
    const entries = await auditRows(id);
    expect(entries.at(-1)?.payload).toMatchObject({
      action: "UPDATE",
      metadata: { event: "zeteo.source.refreshed", ...res.body },
    });
  });

  it("answers 403 to a read-only caller, 404 to an unknown source and 409 to an archived one", async () => {
    const id = await newSource();
    expect((await call("POST", `/${id}/refresh`, readToken())).status).toBe(
      403
    );
    expect((await call("POST", `/${randomUUID()}/refresh`)).status).toBe(404);
    await call("POST", `/${id}/archive`);
    const res = await call("POST", `/${id}/refresh`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("source_archived");
  });

  it("answers 409 nothing_to_sync for an upload source without Sheets tables, and changes nothing", async () => {
    const file = await seedUploadSource({ ownerId: randomUUID(), tables: [] });
    try {
      const res = await call("POST", `/${file.id}/refresh`);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("nothing_to_sync");
      expect(await redis.get(`zeteo:sync-now:${file.id}`)).toBeNull();
      const row = await prisma.source.findUniqueOrThrow({
        where: { id: file.id },
      });
      expect(row.lastRefreshedAt).toBeNull();
      expect(await auditRows(file.id)).toEqual([]);
    } finally {
      await removeUploadSources([file.id]);
    }
  });

  it("answers 502 source_unreachable and marks the source unreachable", async () => {
    const id = await newSource();
    await prisma.source.update({
      where: { id },
      data: {
        sealedSettings: sealSettings(
          sourceSettings("ro", { port: 1 }),
          id
        ) as object,
      },
    });
    await closeSourcePool(id);
    const res = await call("POST", `/${id}/refresh`);
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("source_unreachable");
    expect((await call("GET", `/${id}`)).body.status).toBe("unreachable");
  });
});

describe("POST /v1/sources/:sourceId/refresh of a Google Sheets source (Sync now)", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
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
  const granteeId = randomUUID();
  const grantee = tokenFor({ userId: granteeId, permissions: [DATA_READ] });
  const sheets = new Map<string, FakeSpreadsheet>();
  const made: string[] = [];

  const call = (method: string, path: string, token: string, body?: unknown) =>
    fetchJson(method, `${app.url}/v1/sources${path}`, token, body);

  /** A Sheets source of the owner with one tab, `costs`, made through `POST /v1/sources`. */
  const makeSheets = async () => {
    const sheet = new FakeSpreadsheet(`sheet-${randomUUID()}`, [
      {
        sheetId: 1,
        title: "Costs",
        rows: [
          ["item", "amount"],
          ["rent", "1200"],
        ],
      },
    ]);
    sheets.set(sheet.id, sheet);
    const staged = await stageFakeSheet(ownerId, sheet);
    const res = await fetchJson("POST", `${app.url}/v1/sources`, owner, {
      type: "upload",
      staging_id: staged.stagingId,
      name: "Book",
      tables: [{ key: "sheet:1" }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    made.push(res.body.id);
    return { sheet, id: res.body.id as string };
  };

  beforeAll(async () => {
    app = await startV1Routes();
  });
  beforeEach(() => {
    serveSheets(google, sheets);
  });
  afterEach(async () => {
    for (const id of made.splice(0)) await redis.del(`zeteo:sync-now:${id}`);
  });
  afterAll(async () => {
    await prisma.grant.deleteMany({ where: { principalId: granteeId } });
    await removeUploadSourcesOf([ownerId]);
    await app.close();
  });

  it("the owner can sync their Sheets source; a non-owner without sources.write gets 403; a file-only source gets 409 nothing_to_sync", async () => {
    const { sheet, id } = await makeSheets();
    expect((await call("POST", `/${id}/refresh`, other)).status).toBe(403);
    sheet.tab(1).rows.push(["food", "300"]);
    const res = await call("POST", `/${id}/refresh`, owner);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({
      synced_at: expect.any(String),
      tables: [
        {
          id: expect.any(String),
          name: "costs",
          row_count: 2,
          missing: false,
          error: null,
        },
      ],
    });

    const file = await createUploadSource(
      app.url,
      owner,
      ownerId,
      csvOf(["a"], [["1"]])
    );
    const refused = await call("POST", `/${file.id}/refresh`, owner);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("nothing_to_sync");
    expect(await redis.get(`zeteo:sync-now:${file.id}`)).toBeNull();
  });

  it("Sync now on a source whose only tab was deleted is 200, not 409 nothing_to_sync", async () => {
    const { sheet, id } = await makeSheets();
    sheet.tabs = [];
    const first = await call("POST", `/${id}/refresh`, owner);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.tables).toEqual([
      expect.objectContaining({ name: "costs", missing: true, error: null }),
    ]);
    await redis.del(`zeteo:sync-now:${id}`);
    const again = await call("POST", `/${id}/refresh`, owner);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toEqual({ synced_at: expect.any(String), tables: [] });
    const view = await call("GET", `/${id}`, owner);
    expect(view.body.sync).toMatchObject({ failing: [], stale: false });
  });

  it("Sync now twice within 60 s: second is 429 sync_too_soon with Retry-After", async () => {
    const { id } = await makeSheets();
    expect((await call("POST", `/${id}/refresh`, owner)).status).toBe(200);
    const again = await fetch(`${app.url}/v1/sources/${id}/refresh`, {
      method: "POST",
      headers: { Authorization: `Bearer ${owner}` },
    });
    expect(again.status).toBe(429);
    const body = (await again.json()) as { error: string };
    expect(body.error).toBe("sync_too_soon");
    const retryAfter = Number(again.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  it("a Sync now refused as busy does not take the 60 s window", async () => {
    const { id } = await makeSheets();
    const wait = LOAD_LOCKING.lockWaitMs;
    LOAD_LOCKING.lockWaitMs = 100;
    await redis.set(`zeteo:upload-source-load:${id}`, "other", "EX", 60);
    try {
      const busy = await call("POST", `/${id}/refresh`, owner);
      expect(busy.status).toBe(503);
      expect(busy.body.error).toBe("upload_source_busy");
      expect(await redis.get(`zeteo:sync-now:${id}`)).toBeNull();
    } finally {
      LOAD_LOCKING.lockWaitMs = wait;
      await redis.del(`zeteo:upload-source-load:${id}`);
    }
    expect((await call("POST", `/${id}/refresh`, owner)).status).toBe(200);
  });

  it("a refused caller does not take the 60 s window", async () => {
    const { id } = await makeSheets();
    expect((await call("POST", `/${id}/refresh`, other)).status).toBe(403);
    expect((await call("POST", `/${id}/refresh`, owner)).status).toBe(200);
  });

  it("per-table errors appear on the source's sync.failing, not in a grantee's catalogue", async () => {
    const { sheet, id } = await makeSheets();
    const table = await prisma.sourceTable.findFirstOrThrow({
      where: { sourceId: id },
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
    sheet.failWith = "GGL_0009";

    // Its only table failed: Sync now answers that table's error.
    const res = await call("POST", `/${id}/refresh`, owner);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("sheet_not_accessible");

    const after = await prisma.sourceTable.findUniqueOrThrow({
      where: { id: table.id },
    });
    expect({
      ...after,
      lastSyncError: null,
      lastSyncAttemptAt: null,
    }).toEqual(table);
    const error = {
      code: "sheet_not_accessible",
      message: expect.any(String),
    };
    const view = await call("GET", `/${id}`, owner);
    expect(view.body.sync).toEqual({
      interval_minutes: 60,
      last_attempt_at: expect.any(String),
      failing: [{ table_id: table.id, name: "costs", ...error }],
      stale: false,
    });
    const tables = await call("GET", `/${id}/tables`, owner);
    expect(tables.body.data).toEqual([
      expect.objectContaining({ id: table.id, sync_error: error }),
    ]);
    const detail = await call("GET", `/${id}/tables/${table.id}`, owner);
    expect(detail.body.sync_error).toEqual(error);

    const catalog = await fetchJson("GET", `${app.url}/v1/catalog`, grantee);
    expect(catalog.status).toBe(200);
    const source = catalog.body.sources.find(
      (s: { tables: { name: string }[] }) =>
        s.tables.some((t) => t.name === "costs")
    );
    expect(source.tables[0].last_loaded_at).toBe(
      table.lastSyncedAt!.toISOString()
    );
    expect(source.tables[0]).not.toHaveProperty("last_synced_at");
    const text = JSON.stringify(catalog.body);
    expect(text).not.toContain('"sync"');
    expect(text).not.toContain("sync_error");
    expect(text).not.toContain("sheet_not_accessible");
  });

  it("partial success answers 200 with per-table errors", async () => {
    const { sheet, id } = await makeSheets();
    const other = new FakeSpreadsheet(`sheet-${randomUUID()}`, [
      { sheetId: 1, title: "Stock", rows: [["sku"], ["a1"]] },
    ]);
    sheets.set(other.id, other);
    const staged = await stageFakeSheet(ownerId, other);
    const added = await call("POST", `/${id}/tables`, owner, {
      staging_id: staged.stagingId,
      tables: [{ key: "sheet:1", name: "stock" }],
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    sheet.failWith = "GGL_0009";
    other.tab(1).rows.push(["b2"]);

    const res = await call("POST", `/${id}/refresh`, owner);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({
      synced_at: expect.any(String),
      tables: [
        {
          id: expect.any(String),
          name: "costs",
          row_count: 1,
          missing: false,
          error: { code: "sheet_not_accessible", message: expect.any(String) },
        },
        {
          id: expect.any(String),
          name: "stock",
          row_count: 2,
          missing: false,
          error: null,
        },
      ],
    });
    const view = await call("GET", `/${id}`, owner);
    expect(view.body.sync.failing).toEqual([
      expect.objectContaining({ name: "costs", code: "sheet_not_accessible" }),
    ]);
  });
});
