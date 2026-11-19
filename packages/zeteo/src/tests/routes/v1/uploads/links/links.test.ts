// @module-tag int
// @module-tag platform
import { STAGING_SCHEMA } from "../../../../../uploads/storage.js";
import { startV1Routes } from "../../../../support/v1App.js";
import { uniqueSlug } from "../../../../support/sources.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import { tokenFor } from "../../../../support/tokens.js";
import env from "../../../../../env.js";
import { randomUUID } from "crypto";
import {
  DATA_READ,
  SOURCES_WRITE,
  UPLOADS_WRITE,
} from "../../../../../definitions/tereoDeclaration.js";
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

const getSpreadsheet = vi.fn();
const googleClient = vi.fn();

vi.mock("../../../../../google/handler.js", () => ({
  googleClient: () => googleClient(),
  sheetsApi: {
    getSpreadsheet: (...args: unknown[]) => getSpreadsheet(...args),
  },
  stopGoogleHandler: vi.fn(),
}));

const SHEET_ID = `${"a1B2".repeat(8)}`;
const owner = randomUUID();
const stranger = randomUUID();
const admin = randomUUID();
const tokenOf = (userId: string, extra: string[] = []) =>
  tokenFor({ userId, permissions: [DATA_READ, UPLOADS_WRITE, ...extra] });
const ownerToken = tokenOf(owner);

const str = (stringValue: string) => ({ effectiveValue: { stringValue } });
const num = (numberValue: number) => ({ effectiveValue: { numberValue } });

const FIXTURE = {
  meta: {
    properties: { title: "Budget", timeZone: "UTC" },
    sheets: [
      {
        properties: {
          sheetId: 0,
          title: "Costs",
          index: 0,
          sheetType: "GRID",
          gridProperties: { rowCount: 1000, columnCount: 26 },
        },
      },
      {
        properties: {
          sheetId: 77,
          title: "Chart",
          index: 1,
          sheetType: "OBJECT",
        },
      },
      {
        properties: {
          sheetId: 5,
          title: "Notes",
          index: 2,
          sheetType: "GRID",
          gridProperties: { rowCount: 1000, columnCount: 26 },
        },
      },
    ],
  },
  grid: (title: string) => {
    const rows =
      title === "Costs"
        ? [
            [str("item"), str("amount"), str("paid")],
            [str("rent"), num(1200), { effectiveValue: { boolValue: true } }],
            [str("food"), num(300.5), { effectiveValue: { boolValue: false } }],
          ]
        : [[str("note")], [str("hello")]];
    return {
      sheets: [
        {
          data: [{ startRow: 0, rowData: rows.map((values) => ({ values })) }],
        },
      ],
    };
  },
};

/** Answers the metadata call, then each tab's grid by the title in its range. */
const serveFixture = () => {
  googleClient.mockResolvedValue("google:_:main");
  getSpreadsheet.mockImplementation(
    async (_client: string, _id: string, params: { ranges?: string[] }) => {
      if (!params.ranges) return FIXTURE.meta;
      const title = /^'(.*)'!/.exec(params.ranges[0]!)![1]!;
      return FIXTURE.grid(title);
    }
  );
};

const post = async (token: string, body: unknown) => {
  const res = await fetch(`${app.url}/v1/uploads/links`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, body: (text ? JSON.parse(text) : null) as any };
};

/** An upload source with one table from a spreadsheet (none when `vendorFileId` is null). */
const makeSource = async (
  ownerId: string,
  fields: { vendorFileId?: string | null; archivedAt?: Date } = {}
) => {
  const vendorFileId =
    fields.vendorFileId === undefined
      ? `${SHEET_ID}-${randomUUID().slice(0, 8)}`
      : fields.vendorFileId;
  const source = await prisma.source.create({
    data: {
      slug: uniqueSlug("links"),
      name: "Sheet source",
      type: "upload",
      ownerId,
      sealedSettings: {},
      schemas: [],
      createdBy: owner,
      ...(fields.archivedAt && { archivedAt: fields.archivedAt }),
    },
  });
  if (vendorFileId !== null) {
    await prisma.sourceTable.create({
      data: {
        sourceId: source.id,
        schemaName: `zu_${source.id.replaceAll("-", "")}`,
        name: "tab",
        kind: "table",
        origin: {
          kind: "google-sheets",
          spreadsheetId: vendorFileId,
          spreadsheetTitle: "Sheet",
          sheetId: 0,
          headerRow: 0,
        },
      },
    });
  }
  return { ...source, vendorFileId };
};

let app: Awaited<ReturnType<typeof startV1Routes>>;

beforeAll(async () => {
  app = await startV1Routes();
});
beforeEach(() => {
  getSpreadsheet.mockReset();
  googleClient.mockReset();
  serveFixture();
});
afterEach(async () => {
  const rows = await prisma.uploadStaging.findMany({
    where: { ownerId: { in: [owner, stranger, admin] } },
  });
  for (const row of rows) {
    for (const t of row.tables as { stagingTable: string }[]) {
      await prisma.$executeRawUnsafe(
        `DROP TABLE IF EXISTS "${STAGING_SCHEMA}"."${t.stagingTable}"`
      );
    }
  }
  await prisma.uploadStaging.deleteMany({
    where: { ownerId: { in: [owner, stranger, admin] } },
  });
  await prisma.source.deleteMany({ where: { createdBy: owner } });
  await prisma.connection.deleteMany({});
});
afterAll(async () => {
  await app.close();
});

describe("POST /v1/uploads/links", () => {
  it("stages each grid tab with its sheetId and a preview like an upload", async () => {
    const res = await post(ownerToken, {
      url: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=0`,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.spreadsheet).toEqual({ id: SHEET_ID, title: "Budget" });
    expect(res.body.tables.map((t: { key: string }) => t.key)).toEqual([
      "sheet:0",
      "sheet:5",
    ]);
    const costs = res.body.tables[0];
    expect(costs).toMatchObject({
      name: "costs",
      kind: "sheet",
      header_row: 0,
      row_count: 2,
    });
    expect(
      costs.columns.map(
        (c: { name: string; type: string; samples: string[] }) => [
          c.name,
          c.type,
          c.samples,
        ]
      )
    ).toEqual([
      ["item", "text", ["rent", "food"]],
      ["amount", "number", ["1200", "300.5"]],
      ["paid", "boolean", ["true", "false"]],
    ]);
    const row = await prisma.uploadStaging.findUniqueOrThrow({
      where: { id: res.body.staging_id },
    });
    expect(row).toMatchObject({
      kind: "google-sheets",
      vendorFileId: SHEET_ID,
      ownerId: owner,
    });
    expect(
      (row.tables as { locator: unknown }[]).map((t) => t.locator)
    ).toEqual([{ sheetId: 0 }, { sheetId: 5 }]);
    expect(Date.parse(res.body.expires_at)).toBeGreaterThan(Date.now());
  });

  it("accepts a bare id", async () => {
    const res = await post(ownerToken, { url: SHEET_ID });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it("answers 409 sheet_in_use for a claimed spreadsheet without naming the owner", async () => {
    await makeSource(stranger, { vendorFileId: SHEET_ID });
    const res = await post(ownerToken, { url: SHEET_ID });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("sheet_in_use");
    expect(JSON.stringify(res.body)).not.toContain(stranger);
    expect(getSpreadsheet).not.toHaveBeenCalled();
  });

  it("with source_id stages the source's own spreadsheet for its owner", async () => {
    const source = await makeSource(owner);
    const res = await post(ownerToken, { source_id: source.id });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.spreadsheet.id).toBe(source.vendorFileId);
    const row = await prisma.uploadStaging.findUniqueOrThrow({
      where: { id: res.body.staging_id },
    });
    expect(row.vendorFileId).toBe(source.vendorFileId);
  });

  it("with source_id lets a holder of zeteo.sources.write stage another person's source", async () => {
    const source = await makeSource(owner);
    const res = await post(tokenOf(admin, [SOURCES_WRITE]), {
      source_id: source.id,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it("with another person's source_id is 404", async () => {
    const source = await makeSource(owner);
    const res = await post(tokenOf(stranger), { source_id: source.id });
    expect(res.status).toBe(404);
    expect(getSpreadsheet).not.toHaveBeenCalled();
    expect((await post(ownerToken, { source_id: randomUUID() })).status).toBe(
      404
    );
  });

  it("with the source_id of a source that is not a Sheets source is 409", async () => {
    const source = await makeSource(owner, { vendorFileId: null });
    const res = await post(ownerToken, { source_id: source.id });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_a_sheets_source");
  });

  it("with the source_id of an archived source is 409", async () => {
    const source = await makeSource(owner, { archivedAt: new Date() });
    const res = await post(ownerToken, { source_id: source.id });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("source_archived");
  });

  it("refuses a body naming neither or both", async () => {
    expect((await post(ownerToken, {})).status).toBe(400);
    expect(
      (await post(ownerToken, { url: SHEET_ID, source_id: randomUUID() }))
        .status
    ).toBe(400);
  });

  it("404 google_not_configured when no connection", async () => {
    const { GoogleNotConfiguredError } =
      await import("../../../../../utils/errors.js");
    googleClient.mockRejectedValue(new GoogleNotConfiguredError());
    const res = await post(ownerToken, { url: SHEET_ID });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("google_not_configured");
  });

  it("422 invalid_sheet_link", async () => {
    const res = await post(ownerToken, { url: "https://example.com/x" });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("invalid_sheet_link");
  });

  it("422 sheet_not_accessible passes through, naming the service account", async () => {
    await prisma.connection.create({
      data: {
        provider: "google",
        sealedSettings: {
          sealed: {},
          service_account_email: "sa@proj.iam.gserviceaccount.com",
        },
        updatedBy: owner,
      },
    });
    getSpreadsheet.mockReset();
    getSpreadsheet.mockRejectedValue(
      Object.assign(new Error("denied"), { code: "GGL_0009" })
    );
    const res = await post(ownerToken, { url: SHEET_ID });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("sheet_not_accessible");
    expect(res.body.error_description).toContain(
      "sa@proj.iam.gserviceaccount.com"
    );
    expect(
      await prisma.uploadStaging.count({ where: { ownerId: owner } })
    ).toBe(0);
  });

  it("counts against UPLOAD_MAX_STAGINGS like a file", async () => {
    const max = env.UPLOAD_MAX_STAGINGS;
    env.UPLOAD_MAX_STAGINGS = 1;
    try {
      expect((await post(ownerToken, { url: SHEET_ID })).status).toBe(201);
      const res = await post(ownerToken, { url: SHEET_ID });
      expect(res.status).toBe(429);
      expect(res.body.error).toBe("too_many_stagings");
    } finally {
      env.UPLOAD_MAX_STAGINGS = max;
    }
  });

  it("needs the upload permissions", async () => {
    const res = await post(
      tokenFor({ userId: owner, permissions: [DATA_READ] }),
      {
        url: SHEET_ID,
      }
    );
    expect(res.status).toBe(403);
  });
});
