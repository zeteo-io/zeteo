import type { UploadColumnType } from "../../uploads/types.js";
import { removeSources, uniqueSlug } from "./sources.js";
import { stageUpload } from "../../uploads/staging.js";
import { prisma } from "../../utils/db/prisma.js";
import type { SeededSource } from "./queries.js";
import { Readable } from "node:stream";
import { fetchJson } from "./http.js";
import { randomUUID } from "crypto";
import {
  appendStagingRows,
  createStagingTable,
  dropLoadedTable,
  dropSourceSchema,
  dropStagingTable,
  loadTypedTable,
  schemaFor,
  swapIn,
} from "../../uploads/storage.js";

export interface UploadTableSpec {
  /** A normalized table name. */
  name: string;
  columns: { name: string; type: UploadColumnType }[];
  /** Data rows as a file holds them: text, empty or null for no value. */
  rows: (string | null)[][];
}

const NATIVE_TYPE: Record<UploadColumnType, string> = {
  text: "text",
  number: "numeric",
  boolean: "boolean",
  date: "date",
  timestamp: "timestamp with time zone",
};

/**
 * An upload source as an upload leaves it: its row, its tables' data loaded
 * through storage (staged, typed, swapped in), their catalogue rows, and an
 * owner grant of every table to `ownerId`. `fields` sets other source
 * columns, such as `rowCap`.
 */
export const seedUploadSource = async ({
  ownerId,
  tables,
  fields = {},
}: {
  ownerId: string;
  tables: UploadTableSpec[];
  fields?: { rowCap?: number; timeoutMs?: number; maxJoins?: number };
}): Promise<SeededSource> => {
  const id = randomUUID();
  const schema = schemaFor(id);
  const row = await prisma.source.create({
    data: {
      id,
      slug: uniqueSlug("file"),
      name: "Upload source",
      type: "upload",
      ownerId,
      sealedSettings: {},
      schemas: [schema],
      createdBy: ownerId,
      ...fields,
    },
  });

  const seeded: SeededSource = { id, slug: row.slug, tables: {} };
  for (const table of tables) {
    const width = table.columns.length;
    const staging = await createStagingTable(width);
    try {
      await appendStagingRows(staging, table.rows);
      const { physicalName } = await loadTypedTable(id, staging, {
        name: table.name,
        headerRow: null,
        columns: table.columns.map((c, index) => ({ index, ...c })),
      });
      try {
        const created = await prisma.$transaction(async (tx) => {
          await swapIn(tx, id, table.name, physicalName);
          const t = await tx.sourceTable.create({
            data: {
              sourceId: id,
              schemaName: schema,
              name: table.name,
              kind: "table",
              lastSyncedAt: new Date(),
              rowCount: table.rows.length,
              columns: {
                create: table.columns.map((c, i) => ({
                  name: c.name,
                  type: c.type,
                  nativeType: NATIVE_TYPE[c.type],
                  nullable: true,
                  position: i + 1,
                  isPrimaryKey: false,
                  originalName: c.name,
                  description: c.name,
                })),
              },
            },
            include: { columns: true },
          });
          await tx.grant.create({
            data: {
              principalType: "user",
              principalId: ownerId,
              tableId: t.id,
              allColumns: true,
              ownerGrant: true,
              createdBy: ownerId,
            },
          });
          return t;
        });
        seeded.tables[table.name] = {
          id: created.id,
          columns: Object.fromEntries(
            created.columns.map((c) => [c.name, c.id])
          ),
        };
      } catch (err) {
        await dropLoadedTable(id, physicalName);
        throw err;
      }
    } finally {
      await dropStagingTable(staging);
    }
  }
  return seeded;
};

/** Drops the upload sources' schemas, then removes them as `removeSources` does. */
export const removeUploadSources = async (ids: string[]): Promise<void> => {
  for (const id of ids) await dropSourceSchema(id);
  await removeSources(ids);
};

/** Stages `content` for `ownerId` as an upload would, and returns the staging id and preview. */
export const stageFile = async (
  ownerId: string,
  content: string | Buffer,
  filename = "data.csv"
) =>
  stageUpload({
    ownerId,
    filename,
    stream: Readable.from([Buffer.from(content)]),
  });

/** A CSV of `header` and `rows`, comma separated, with no quoting. */
export const csvOf = (header: string[], rows: string[][]): string =>
  [header, ...rows].map((r) => r.join(",")).join("\n");

/** A `/v1/sources` call on the app at `baseUrl`. */
export const sourcesCall = (
  baseUrl: string,
  method: string,
  path: string,
  token: string,
  body?: unknown
) => fetchJson(method, `${baseUrl}/v1/sources${path}`, token, body);

/** A `/v1/uploads` call on the app at `baseUrl`. */
export const uploadsCall = (
  baseUrl: string,
  method: string,
  path: string,
  token: string,
  body?: unknown
) => fetchJson(method, `${baseUrl}/v1/uploads${path}`, token, body);

/** Whether the upload source's `zu_` schema exists. */
export const schemaExists = async (sourceId: string): Promise<boolean> => {
  const rows = await prisma.$queryRaw<Array<{ n: number }>>`
    SELECT 1 AS n FROM pg_namespace WHERE nspname = ${schemaFor(sourceId)}`;
  return rows.length > 0;
};

/** The table names in the upload source's schema, sorted. */
export const storedTables = async (sourceId: string): Promise<string[]> => {
  const rows = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = ${schemaFor(sourceId)}
    ORDER BY tablename`;
  return rows.map((r) => r.tablename);
};

/** Removes the upload sources these owners have, as `removeUploadSources` does, and their stagings. */
export const removeUploadSourcesOf = async (ownerIds: string[]) => {
  const rows = await prisma.source.findMany({
    where: { ownerId: { in: ownerIds } },
    select: { id: true },
  });
  await removeUploadSources(rows.map((r) => r.id));
  const stagings = await prisma.uploadStaging.findMany({
    where: { ownerId: { in: ownerIds } },
  });
  for (const s of stagings) {
    for (const t of s.tables as { stagingTable: string }[]) {
      await dropStagingTable(t.stagingTable);
    }
  }
  await prisma.uploadStaging.deleteMany({
    where: { ownerId: { in: ownerIds } },
  });
};

/**
 * The tables of an upload source as the catalogue holds them, by name, missing
 * ones included and flagged, with their columns in order: what a test checks
 * after a change, which answers with the source alone.
 */
export const uploadTablesOf = async (sourceId: string) => {
  const tables = await prisma.sourceTable.findMany({
    where: { sourceId },
    orderBy: { name: "asc" },
    include: { columns: { orderBy: { position: "asc" } } },
  });
  return tables.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    row_count: Number(t.rowCount ?? 0),
    last_loaded_at: t.lastSyncedAt?.toISOString() ?? null,
    missing: t.missingSince !== null,
    columns: t.columns.map((c) => ({
      id: c.id,
      name: c.name,
      original_name: c.originalName,
      type: c.type,
      description: c.description,
      missing: c.missingSince !== null,
    })),
  }));
};

export type UploadTable = Awaited<ReturnType<typeof uploadTablesOf>>[number];

/**
 * An upload source of `ownerId` made through `POST /v1/sources` (`type:
 * "upload"`) on the app at `baseUrl` from `csv`, keeping its one table as
 * `table`; throws unless it is created. Its `tables` are `uploadTablesOf`'s.
 */
export const createUploadSource = async (
  baseUrl: string,
  token: string,
  ownerId: string,
  csv: string,
  {
    name = "Upload source",
    table = "data",
  }: { name?: string; table?: string } = {}
) => {
  const staged = await stageFile(ownerId, csv);
  const res = await sourcesCall(baseUrl, "POST", "", token, {
    type: "upload",
    staging_id: staged.stagingId,
    name,
    tables: [{ key: "csv", name: table }],
  });
  if (res.status !== 201) {
    throw new Error(`upload source not created: ${JSON.stringify(res.body)}`);
  }
  const body = res.body as UploadSourceBody;
  return { ...body, tables: await uploadTablesOf(body.id) };
};

/** The fields of a source's view the upload source tests read. */
export interface UploadSourceBody {
  id: string;
  slug: string;
  name: string;
  description: string;
  type: string;
  owner_id: string;
  archived_at: string | null;
  size_bytes: number;
  share_count: number;
}
