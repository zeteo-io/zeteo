// @module-tag int
// @module-tag platform
import { STAGING_SCHEMA } from "../../../../../file-sources/storage.js";
import { startV1Routes } from "../../../../support/v1App.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import { tokenFor } from "../../../../support/tokens.js";
import env from "../../../../../env.js";
import { randomUUID } from "crypto";
import ExcelJS from "exceljs";
import http from "node:http";
import JSZip from "jszip";
import {
  DATA_READ,
  FILE_SOURCES_WRITE,
} from "../../../../../definitions/tereoDeclaration.js";
import {
  discardStaging,
  getStaging,
  STAGING_TTL_MS,
} from "../../../../../file-sources/staging.js";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const owner = randomUUID();
const ownerToken = tokenFor({
  userId: owner,
  permissions: [DATA_READ, FILE_SOURCES_WRITE],
});

const upload = async (
  token: string,
  content: Buffer | string,
  filename = "data.csv",
  field = "file"
) => {
  const form = new FormData();
  form.append(
    field,
    new Blob([new Uint8Array(Buffer.from(content))]),
    filename
  );
  const res = await fetch(`${app.url}/v1/file-sources/uploads`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const text = await res.text();
  return {
    status: res.status,
    connection: res.headers.get("connection"),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    body: (text ? JSON.parse(text) : null) as any,
  };
};

const stagingTables = async () =>
  (
    await prisma.$queryRawUnsafe<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
      STAGING_SCHEMA
    )
  ).map((r) => r.table_name);

let app: Awaited<ReturnType<typeof startV1Routes>>;
const made: string[] = [];

beforeAll(async () => {
  app = await startV1Routes();
});
afterEach(async () => {
  const rows = await prisma.fileStaging.findMany({
    where: { ownerId: owner },
  });
  for (const row of rows) {
    for (const t of row.tables as { stagingTable: string }[]) {
      await prisma.$executeRawUnsafe(
        `DROP TABLE IF EXISTS "${STAGING_SCHEMA}"."${t.stagingTable}"`
      );
    }
  }
  await prisma.fileStaging.deleteMany({ where: { ownerId: owner } });
  made.length = 0;
});
afterAll(async () => {
  await app.close();
});

describe("POST /v1/file-sources/uploads", () => {
  it("stages a CSV as one table with inferred types and samples", async () => {
    const lines = ["Order ID,Total,Shipped,Placed,Zip,Note"];
    for (let i = 1; i <= 30; i++) {
      lines.push(
        `${i},${i}.5,true,2024-01-${String((i % 28) + 1).padStart(2, "0")},0${i}0,`
      );
    }
    const res = await upload(ownerToken, lines.join("\n"), "My Orders.csv");
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.tables).toHaveLength(1);
    const table = res.body.tables[0];
    expect(table).toMatchObject({
      key: "csv",
      name: "my_orders",
      kind: "csv",
      header_row: 0,
      row_count: 30,
    });
    expect(
      table.columns.map((c: { name: string; type: string }) => [c.name, c.type])
    ).toEqual([
      ["order_id", "number"],
      ["total", "number"],
      ["shipped", "boolean"],
      ["placed", "date"],
      ["zip", "text"],
      ["note", "text"],
    ]);
    expect(table.columns[0]).toMatchObject({
      index: 0,
      original_name: "Order ID",
    });
    expect(table.columns[0].samples).toEqual(
      Array.from({ length: 10 }, (_, i) => String(i + 1))
    );
    expect(table.columns[5].samples).toEqual([]);

    const expires = new Date(res.body.expires_at).getTime();
    expect(Math.abs(expires - Date.now() - STAGING_TTL_MS)).toBeLessThan(
      60_000
    );
    // The staging table holds every row, the header included.
    const staging = await getStaging(res.body.staging_id, owner);
    expect(staging.tables).toHaveLength(1);
    const [{ count }] = await prisma.$queryRawUnsafe<{ count: number }[]>(
      `SELECT count(*)::int AS count FROM "${STAGING_SCHEMA}"."${staging.tables[0]!.stagingTable}"`
    );
    expect(count).toBe(31);
    expect(staging.tables[0]).toMatchObject({
      key: "csv",
      rowCount: 31,
      columnCount: 6,
    });
  });

  it("reports no header when the first row looks like data", async () => {
    const res = await upload(ownerToken, "1,2\n3,4\n5,6\n");
    expect(res.status).toBe(201);
    const table = res.body.tables[0];
    expect(table.header_row).toBeNull();
    expect(table.row_count).toBe(3);
    expect(table.columns.map((c: { name: string }) => c.name)).toEqual([
      "column_1",
      "column_2",
    ]);
  });

  it("returns one entry per xlsx sheet and named table", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sales");
    ws.addRows([
      ["x", "y"],
      [1, 2],
    ]);
    ws.addTable({
      name: "Orders",
      ref: "D2",
      columns: [{ name: "id" }, { name: "total" }],
      rows: [
        [1, 10],
        [2, 20],
      ],
    });
    wb.addWorksheet("Other").addRows([["k"], ["v"]]);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const res = await upload(ownerToken, buffer, "book.xlsx");
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(
      res.body.tables.map((t: { key: string; kind: string }) => [t.key, t.kind])
    ).toEqual([
      ["sheet:Sales", "sheet"],
      ["table:Orders", "table"],
      ["sheet:Other", "sheet"],
    ]);
    const orders = res.body.tables[1];
    expect(orders.columns.map((c: { type: string }) => c.type)).toEqual([
      "number",
      "number",
    ]);
    expect(orders.row_count).toBe(2);
    const staging = await getStaging(res.body.staging_id, owner);
    expect(staging.tables).toHaveLength(3);
  });

  it("needs the file-sources permission and data read", async () => {
    for (const permissions of [[DATA_READ], [FILE_SOURCES_WRITE], []]) {
      const res = await upload(tokenFor({ permissions }), "a,b\n1,2\n");
      expect(res.status).toBe(403);
    }
    const none = await fetch(`${app.url}/v1/file-sources/uploads`, {
      method: "POST",
    });
    expect(none.status).toBe(401);
  });

  it("answers 404 file_sources_not_configured when the feature is off", async () => {
    const url = env.FILE_SOURCES_READER_URL;
    env.FILE_SOURCES_READER_URL = undefined;
    try {
      const res = await upload(ownerToken, "a,b\n1,2\n");
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("file_sources_not_configured");
      const denied = await upload(tokenFor({ permissions: [] }), "a\n1\n");
      expect(denied.status).toBe(404);
    } finally {
      env.FILE_SOURCES_READER_URL = url;
    }
  });

  it("refuses a file over the byte limit mid-stream and keeps nothing", async () => {
    const before = await stagingTables();
    const rowsBefore = await prisma.fileStaging.count();
    const max = env.FILE_SOURCE_MAX_BYTES;
    env.FILE_SOURCE_MAX_BYTES = 200_000;
    try {
      // Enough rows that the staging table exists before the limit is hit.
      const row = "abcdefghij,klmnopqrst,uvwxyz\n";
      const res = await upload(
        ownerToken,
        "a,b,c\n" + row.repeat(20_000),
        "big.csv"
      );
      expect(res.status).toBe(413);
      expect(res.body.error).toBe("file_too_large");
      expect(res.connection).toBe("close");
    } finally {
      env.FILE_SOURCE_MAX_BYTES = max;
    }
    expect(await prisma.fileStaging.count()).toBe(rowsBefore);
    expect((await stagingTables()).sort()).toEqual(before.sort());
  });

  it("refuses an xlsx over the byte limit", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("S").addRows([["a"], ["b"]]);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    const max = env.FILE_SOURCE_MAX_BYTES;
    env.FILE_SOURCE_MAX_BYTES = 500;
    try {
      const res = await upload(ownerToken, buffer, "s.xlsx");
      expect(res.status).toBe(413);
      expect(res.body.error).toBe("file_too_large");
    } finally {
      env.FILE_SOURCE_MAX_BYTES = max;
    }
  });

  it("refuses an unsupported file by content, whatever its name", async () => {
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d,
    ]);
    const res = await upload(ownerToken, png, "pretend.csv");
    expect(res.status).toBe(415);
    expect(res.body.error).toBe("unsupported_file_type");
    const binary = await upload(
      ownerToken,
      Buffer.from([0x01, 0x02, 0x00, 0x03, 0x00, 0x04]),
      "x.xlsx"
    );
    expect(binary.status).toBe(415);
  });

  it("treats CSV text named .xlsx as CSV, and undecodable text as unsupported_encoding", async () => {
    const csv = await upload(ownerToken, "a,b\n1,2\n", "named.xlsx");
    expect(csv.status).toBe(201);
    const latin1 = await upload(
      ownerToken,
      Buffer.from([0x61, 0x2c, 0x62, 0x0a, 0xe9, 0x2c, 0x32, 0x0a]),
      "latin.csv"
    );
    expect(latin1.status).toBe(422);
    expect(latin1.body.error).toBe("unsupported_encoding");
  });

  it("names the row of a parse error and leaves nothing behind", async () => {
    const before = await stagingTables();
    const res = await upload(ownerToken, "a,b\n1,2\n3,4,5\n");
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: "row_too_long", row: 3 });
    expect((await stagingTables()).sort()).toEqual(before.sort());
  });

  it("rejects a request without a file, an empty file and a second file", async () => {
    const noFile = await upload(ownerToken, "a,b\n", "x.csv", "other");
    expect(noFile.status).toBe(400);
    expect((await upload(ownerToken, "")).status).toBe(422);
    const plain = await fetch(`${app.url}/v1/file-sources/uploads`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(plain.status).toBe(400);
    const form = new FormData();
    form.append("file", new Blob(["a,b\n1,2\n"]), "a.csv");
    form.append("file", new Blob(["a,b\n1,2\n"]), "b.csv");
    const rowsBefore = await prisma.fileStaging.count();
    const tablesBefore = (await stagingTables()).sort();
    const two = await fetch(`${app.url}/v1/file-sources/uploads`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: form,
    });
    expect(two.status).toBe(400);
    // The first file's staging is cancelled and removed, not left behind.
    expect(await prisma.fileStaging.count()).toBe(rowsBefore);
    expect((await stagingTables()).sort()).toEqual(tablesBefore);
  });

  it("drops its staging table when the client goes away mid-upload", async () => {
    const before = (await stagingTables()).sort();
    const rowsBefore = await prisma.fileStaging.count();
    const boundary = "----zeteotest";
    const head =
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.csv"\r\n` +
      `Content-Type: text/csv\r\n\r\n`;
    const part = "a,b,c\n" + "abcdefghij,klmnopqrst,uvwxyz\n".repeat(5_000);
    await new Promise<void>((resolve) => {
      const req = http.request(
        `${app.url}/v1/file-sources/uploads`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            // Promises far more than is sent.
            "Content-Length": String(10_000_000),
          },
        },
        () => undefined
      );
      req.on("error", () => resolve());
      req.write(head + part);
      // Give the server time to stage rows, then cut the connection.
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 500);
    });
    // The staging table existed meanwhile; it must go, and no row appear.
    await vi.waitFor(
      async () => {
        expect((await stagingTables()).sort()).toEqual(before);
      },
      { timeout: 10_000, interval: 100 }
    );
    expect(await prisma.fileStaging.count()).toBe(rowsBefore);
  });

  it("refuses an xlsx whose directory understates an entry's size", async () => {
    const zip = new JSZip();
    zip.file("xl/bomb.bin", Buffer.alloc(8 * 1024 * 1024));
    const bomb = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
    });
    const central = bomb.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bomb.writeUInt32LE(1000, central + 24);
    const res = await upload(ownerToken, bomb, "liar.xlsx");
    expect(res.status).toBe(413);
    expect(res.body.error).toBe("file_too_large");
  });

  it("refuses a zip bomb as file_too_large", async () => {
    const zip = new JSZip();
    zip.file("xl/bomb.bin", Buffer.alloc(8 * 1024 * 1024));
    const bomb = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
    });
    expect(bomb.length).toBeLessThan(100_000);
    const res = await upload(ownerToken, bomb, "bomb.xlsx");
    expect(res.status).toBe(413);
    expect(res.body.error).toBe("file_too_large");
  });
});

describe("discardStaging", () => {
  it("is safe to run twice, also at once", async () => {
    const res = await upload(ownerToken, "a,b\n1,2\n");
    const id = res.body.staging_id as string;
    await Promise.all([discardStaging(id), discardStaging(id)]);
    await discardStaging(id);
    expect(await prisma.fileStaging.findUnique({ where: { id } })).toBeNull();
  });
});

describe("getStaging", () => {
  it("answers only its creator, and not once expired", async () => {
    const res = await upload(ownerToken, "a,b\n1,2\n");
    const id = res.body.staging_id as string;
    expect((await getStaging(id, owner)).id).toBe(id);
    await expect(getStaging(id, randomUUID())).rejects.toMatchObject({
      statusCode: 404,
      code: "staging_not_found",
    });
    await expect(
      getStaging(id, owner, new Date(Date.now() + 2 * STAGING_TTL_MS))
    ).rejects.toMatchObject({ code: "staging_not_found" });
    await expect(getStaging(randomUUID(), owner)).rejects.toMatchObject({
      code: "staging_not_found",
    });
  });
});
