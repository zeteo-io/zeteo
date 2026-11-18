// @module-tag int
// @module-tag platform
// @module-tag security
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import { randomUUID } from "crypto";
import env from "../../env.js";
import pg from "pg";
import {
  appendStagingRows,
  CastFailedError,
  checkFileSourcesSetup,
  checkReaderRole,
  createStagingTable,
  dropLoadedTable,
  dropStaleLoads,
  dropSourceSchema,
  dropStagingTable,
  ensureSourceSchema,
  loadTypedTable,
  type LoadSpec,
  schemaFor,
  STAGING_SCHEMA,
  storedBytes,
  swapIn,
} from "../../file-sources/storage.js";

/** Postgres refused for lack of a privilege. */
const PERMISSION_DENIED = "42501";

const readerUrl = Object.assign(
  () => {
    if (!env.FILE_SOURCES_READER_URL) {
      throw new Error("the test environment sets FILE_SOURCES_READER_URL");
    }
    return env.FILE_SOURCES_READER_URL;
  },
  { original: env.FILE_SOURCES_READER_URL }
);

/** The reader's role, as the URL names it. */
const readerRole = () => decodeURIComponent(new URL(readerUrl()).username);

/** Runs SQL as Zeteo's own login, a superuser in the test stack. */
const asAdmin = (sql: string) => prisma.$executeRawUnsafe(sql);

const testDatabase = async (): Promise<string> => {
  const [{ db }] = await prisma.$queryRaw<Array<{ db: string }>>`
    SELECT current_database() AS db`;
  return db;
};

const readers: pg.Client[] = [];
const reader = async (): Promise<pg.Client> => {
  const client = new pg.Client({ connectionString: readerUrl() });
  await client.connect();
  readers.push(client);
  return client;
};

const ORDERS: LoadSpec = {
  name: "orders",
  headerRow: 0,
  columns: [
    { index: 0, name: "id", type: "text" },
    { index: 1, name: "amount", type: "number" },
    { index: 2, name: "paid", type: "boolean" },
    { index: 3, name: "day", type: "date" },
    { index: 4, name: "at", type: "timestamp" },
  ],
};

const stage = async (rows: (string | null)[][]): Promise<string> => {
  const staging = await createStagingTable(rows[0].length);
  stagings.push(staging);
  await appendStagingRows(staging, rows);
  return staging;
};

const tablesIn = async (schema: string): Promise<string[]> => {
  const rows = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = ${schema} ORDER BY tablename`;
  return rows.map((r) => r.tablename);
};

let sourceId: string;
let stagings: string[] = [];
const sourceIds: string[] = [];

beforeEach(async () => {
  sourceId = randomUUID();
  sourceIds.push(sourceId);
  stagings = [];
  await ensureSourceSchema(sourceId);
});

afterEach(async () => {
  for (const client of readers.splice(0)) await client.end();
  for (const staging of stagings) await dropStagingTable(staging);
});

afterAll(async () => {
  for (const id of sourceIds) await dropSourceSchema(id);
  await prisma.source.deleteMany({ where: { id: { in: sourceIds } } });
});

describe("schemaFor", () => {
  it("names a source's schema zf_ and its id's 32 hex digits", () => {
    expect(schemaFor("0195f3a2-1b2c-7d3e-8f40-123456789abc")).toBe(
      "zf_0195f3a21b2c7d3e8f40123456789abc"
    );
  });

  it("refuses anything but a UUID", () => {
    expect(() => schemaFor('x"; DROP SCHEMA zeteo; --')).toThrow();
  });
});

describe("loadTypedTable and swapIn", () => {
  it("stores typed values and swaps atomically", async () => {
    const first = await stage([
      ["Order", "Amount", "Paid", "Day", "At"],
      ["A-1", " 2.50 ", "TRUE", "2024-01-02", "2024-01-02T03:04:05Z"],
      ["A-2", "", "false", "", ""],
    ]);
    const loaded = await loadTypedTable(sourceId, first, ORDERS);
    expect(loaded.rowCount).toBe(2);
    expect(loaded.physicalName).toMatch(/^orders__load_[0-9a-f]+$/);
    await prisma.$transaction((tx) =>
      swapIn(tx, sourceId, "orders", loaded.physicalName)
    );
    expect(await tablesIn(schemaFor(sourceId))).toEqual(["orders"]);

    const schema = schemaFor(sourceId);
    const client = await reader();
    const { rows } = await client.query(
      `SELECT id, amount, pg_typeof(amount)::text AS amount_type, paid,
              to_char(day, 'YYYY-MM-DD') AS day, pg_typeof(day)::text AS day_type,
              at, pg_typeof(at)::text AS at_type
       FROM "${schema}"."orders" ORDER BY id`
    );
    expect(rows).toEqual([
      {
        id: "A-1",
        amount: "2.50",
        amount_type: "numeric",
        paid: true,
        day: "2024-01-02",
        day_type: "date",
        at: new Date("2024-01-02T03:04:05Z"),
        at_type: "timestamp with time zone",
      },
      {
        id: "A-2",
        amount: null,
        amount_type: "numeric",
        paid: false,
        day: null,
        day_type: "date",
        at: null,
        at_type: "timestamp with time zone",
      },
    ]);

    // A second load, while a reader's transaction is reading the table.
    const second = await stage([
      ["Order", "Amount", "Paid", "Day", "At"],
      ["B-1", "7", "true", "2025-05-06", "2025-05-06 07:08:09+02:00"],
    ]);
    const reloaded = await loadTypedTable(sourceId, second, ORDERS);
    await client.query("BEGIN");
    const before = await client.query(
      `SELECT id FROM "${schema}"."orders" ORDER BY id`
    );
    expect(before.rows.map((r) => r.id)).toEqual(["A-1", "A-2"]);

    const swapping = prisma.$transaction((tx) =>
      swapIn(tx, sourceId, "orders", reloaded.physicalName)
    );
    // The swap waits on the reader's lock rather than pulling the table away.
    await expect
      .poll(
        async () => {
          const waiting = await prisma.$queryRaw<Array<{ n: number }>>`
            SELECT count(*)::int AS n FROM pg_locks l
            JOIN pg_class c ON c.oid = l.relation
            JOIN pg_namespace ns ON ns.oid = c.relnamespace
            WHERE NOT l.granted AND ns.nspname = ${schema}`;
          return waiting[0].n;
        },
        { timeout: 5000 }
      )
      .toBeGreaterThan(0);
    const during = await client.query(
      `SELECT id FROM "${schema}"."orders" ORDER BY id`
    );
    expect(during.rows.map((r) => r.id)).toEqual(["A-1", "A-2"]);
    await client.query("COMMIT");
    await swapping;

    const after = await client.query(
      `SELECT id, at FROM "${schema}"."orders" ORDER BY id`
    );
    expect(after.rows).toEqual([
      { id: "B-1", at: new Date("2025-05-06T05:08:09Z") },
    ]);
    expect(await tablesIn(schema)).toEqual(["orders"]);

    // The reader reads; it never writes.
    await expect(
      client.query(`INSERT INTO "${schema}"."orders" (id) VALUES ('C-1')`)
    ).rejects.toMatchObject({ code: PERMISSION_DENIED });
    await expect(
      client.query(`CREATE TABLE "${schema}"."mine" (x int)`)
    ).rejects.toMatchObject({ code: PERMISSION_DENIED });
  });

  it("cast failure creates nothing", async () => {
    const staging = await stage([
      ["N", "Label"],
      ["1", "one"],
      ["two", "two"],
      ["3", "three"],
    ]);
    const failure = await loadTypedTable(sourceId, staging, {
      name: "numbers",
      headerRow: 0,
      columns: [
        { index: 0, name: "n", type: "number" },
        { index: 1, name: "label", type: "text" },
      ],
    }).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(CastFailedError);
    expect(failure).toMatchObject({ column: "n", rows: [3] });
    expect(await tablesIn(schemaFor(sourceId))).toEqual([]);
  });

  it("names the first five failing rows of the first failing column", async () => {
    const staging = await stage([
      ["2024-01-01", "x"],
      ["01/02/2024", "x"],
      ["2024-02-30", "x"],
      ["", "x"],
      ["soon", "x"],
      ["2024-13-01", "x"],
      ["24-01-01", "x"],
      ["later", "x"],
    ]);
    const failure = await loadTypedTable(sourceId, staging, {
      name: "days",
      headerRow: null,
      columns: [
        { index: 0, name: "day", type: "date" },
        { index: 1, name: "flag", type: "text" },
      ],
    }).catch((err: unknown) => err);
    expect(failure).toMatchObject({ column: "day", rows: [2, 3, 5, 6, 7] });
    expect(await tablesIn(schemaFor(sourceId))).toEqual([]);
  });
});

describe("the reader role", () => {
  it("reader role cannot read zeteo, core or staging", async () => {
    const staging = await stage([["secret"]]);
    const client = await reader();
    for (const sql of [
      `SELECT 1 FROM "zeteo"."sources" LIMIT 1`,
      `SELECT 1 FROM "zeteo"."file_stagings" LIMIT 1`,
      `SELECT 1 FROM "core"."core_outbox" LIMIT 1`,
      `SELECT * FROM "${STAGING_SCHEMA}"."${staging}"`,
      // PUBLIC's TEMP is revoked: no temporary tables either.
      `CREATE TEMP TABLE scratch (x int)`,
    ]) {
      await expect(client.query(sql), sql).rejects.toMatchObject({
        code: PERMISSION_DENIED,
      });
    }
  });

  it("checkFileSourcesSetup accepts the test stack's setup", async () => {
    await expect(checkFileSourcesSetup()).resolves.toBeUndefined();
  });

  it("checkFileSourcesSetup refuses an sslmode Zeteo cannot use, saying so", async () => {
    const url = new URL(readerUrl());
    url.searchParams.set("sslmode", "verify-ca");
    env.FILE_SOURCES_READER_URL = url.toString();
    try {
      await expect(checkFileSourcesSetup()).rejects.toThrow(
        /sslmode must be disable, require or verify-full, not "verify-ca"/
      );
    } finally {
      env.FILE_SOURCES_READER_URL = readerUrl.original;
    }
  });

  it("checkReaderRole accepts the configured URL", async () => {
    await expect(checkReaderRole()).resolves.toBeUndefined();
  });

  it("checkReaderRole rejects a URL to another database", async () => {
    const other = new URL(readerUrl());
    other.pathname = "/postgres";
    await expect(checkReaderRole(other.toString())).rejects.toThrow(/database/);
  });

  it("checkReaderRole rejects another role than the one granted to", async () => {
    // Zeteo's own login reads everything.
    await expect(checkReaderRole(env.DATABASE_URL)).rejects.toThrow(
      /must sign in as/
    );
    const other = `zeteo_files_other_${randomUUID().slice(0, 8)}`;
    await asAdmin(`CREATE ROLE "${other}" LOGIN PASSWORD 'other-test-only'`);
    try {
      const url = new URL(readerUrl());
      url.username = other;
      url.password = "other-test-only";
      await expect(checkReaderRole(url.toString())).rejects.toThrow(
        /must sign in as/
      );
    } finally {
      await asAdmin(`DROP ROLE "${other}"`);
    }
  });

  it("checkReaderRole rejects a reader that is a member of a role", async () => {
    const group = `zeteo_files_group_${randomUUID().slice(0, 8)}`;
    await asAdmin(`CREATE ROLE "${group}"`);
    await asAdmin(`GRANT "${group}" TO "${readerRole()}"`);
    try {
      await expect(checkReaderRole()).rejects.toThrow(
        new RegExp(`member of any role \\(${group}\\)`)
      );
    } finally {
      await asAdmin(`REVOKE "${group}" FROM "${readerRole()}"`);
      await asAdmin(`DROP ROLE "${group}"`);
    }
  });

  it("checkReaderRole rejects a reader with TEMP on the database", async () => {
    const db = await testDatabase();
    await asAdmin(`GRANT TEMP ON DATABASE "${db}" TO "${readerRole()}"`);
    try {
      await expect(checkReaderRole()).rejects.toThrow(/TEMP or CREATE/);
    } finally {
      await asAdmin(`REVOKE TEMP ON DATABASE "${db}" FROM "${readerRole()}"`);
    }
  });

  it("checkReaderRole rejects a reader that can use zeteo's schema", async () => {
    await asAdmin(`GRANT USAGE ON SCHEMA "zeteo" TO "${readerRole()}"`);
    try {
      await expect(checkReaderRole()).rejects.toThrow(
        /must not use the schemas zeteo/
      );
    } finally {
      await asAdmin(`REVOKE USAGE ON SCHEMA "zeteo" FROM "${readerRole()}"`);
    }
  });
});

describe("loads never swapped in", () => {
  const letters = (name: string): LoadSpec => ({
    name,
    headerRow: null,
    columns: [{ index: 0, name: "letter", type: "text" }],
  });

  it("dropLoadedTable drops a load and nothing but a load", async () => {
    const staging = await stage([["a"]]);
    const loaded = await loadTypedTable(sourceId, staging, letters("letters"));
    await dropLoadedTable(sourceId, loaded.physicalName);
    expect(await tablesIn(schemaFor(sourceId))).toEqual([]);
    await expect(dropLoadedTable(sourceId, "letters")).rejects.toThrow(
      /Not a loaded table/
    );
  });

  it("a new load of a table drops that table's stale loads only", async () => {
    const staging = await stage([["a"]]);
    const stranded = await loadTypedTable(
      sourceId,
      staging,
      letters("letters")
    );
    const other = await loadTypedTable(sourceId, staging, letters("others"));
    const fresh = await loadTypedTable(sourceId, staging, letters("letters"));
    expect(await tablesIn(schemaFor(sourceId))).toEqual(
      [fresh.physicalName, other.physicalName].sort()
    );
    expect(fresh.physicalName).not.toBe(stranded.physicalName);
  });

  it("dropStaleLoads drops every load and keeps swapped-in tables", async () => {
    const staging = await stage([["a"]]);
    const kept = await loadTypedTable(sourceId, staging, letters("letters"));
    await prisma.$transaction((tx) =>
      swapIn(tx, sourceId, "letters", kept.physicalName)
    );
    await loadTypedTable(sourceId, staging, letters("others"));
    await loadTypedTable(sourceId, staging, letters("letters"));
    await dropStaleLoads(sourceId);
    expect(await tablesIn(schemaFor(sourceId))).toEqual(["letters"]);
  });

  it("refuses a table named like a load", async () => {
    const staging = await stage([["a"]]);
    await expect(
      loadTypedTable(sourceId, staging, letters("x__load_0123456789ab"))
    ).rejects.toThrow(/named like a load/);
  });
});

describe("dropSourceSchema", () => {
  it("dropSourceSchema removes the data", async () => {
    const staging = await stage([["a"], ["b"]]);
    const loaded = await loadTypedTable(sourceId, staging, {
      name: "letters",
      headerRow: null,
      columns: [{ index: 0, name: "letter", type: "text" }],
    });
    await prisma.$transaction((tx) =>
      swapIn(tx, sourceId, "letters", loaded.physicalName)
    );
    await dropSourceSchema(sourceId);
    const found = await prisma.$queryRaw<unknown[]>`
      SELECT 1 FROM pg_namespace WHERE nspname = ${schemaFor(sourceId)}`;
    expect(found).toEqual([]);
    const client = await reader();
    await expect(
      client.query(`SELECT * FROM "${schemaFor(sourceId)}"."letters"`)
    ).rejects.toMatchObject({ code: "42P01" });
  });
});

describe("storedBytes", () => {
  it("sums the owner's file sources that are not archived", async () => {
    const ownerId = randomUUID();
    expect(await storedBytes(ownerId)).toBe(0);
    await prisma.source.create({
      data: {
        id: sourceId,
        slug: `file-${sourceId.slice(0, 8)}`,
        name: "Upload",
        type: "upload",
        sealedSettings: {},
        ownerId,
        createdBy: ownerId,
      },
    });
    const staging = await stage([["a"], ["b"]]);
    const loaded = await loadTypedTable(sourceId, staging, {
      name: "letters",
      headerRow: null,
      columns: [{ index: 0, name: "letter", type: "text" }],
    });
    await prisma.$transaction((tx) =>
      swapIn(tx, sourceId, "letters", loaded.physicalName)
    );
    expect(await storedBytes(ownerId)).toBeGreaterThan(0);
    await prisma.source.update({
      where: { id: sourceId },
      data: { archivedAt: new Date() },
    });
    expect(await storedBytes(ownerId)).toBe(0);
  });
});
