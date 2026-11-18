import type { FileColumnType } from "../../file-sources/types.js";
import { stageUpload } from "../../file-sources/staging.js";
import { removeSources, uniqueSlug } from "./sources.js";
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
} from "../../file-sources/storage.js";

export interface UploadTableSpec {
  /** A normalized table name. */
  name: string;
  columns: { name: string; type: FileColumnType }[];
  /** Data rows as a file holds them: text, empty or null for no value. */
  rows: (string | null)[][];
}

const NATIVE_TYPE: Record<FileColumnType, string> = {
  text: "text",
  number: "numeric",
  boolean: "boolean",
  date: "date",
  timestamp: "timestamp with time zone",
};

/**
 * A file source as an upload leaves it: its row, its tables' data loaded
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
      name: "File source",
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

/** Drops the file sources' schemas, then removes them as `removeSources` does. */
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

/** A `/v1/file-sources` call on the app at `baseUrl`. */
export const fileSourcesCall = (
  baseUrl: string,
  method: string,
  path: string,
  token: string,
  body?: unknown
) => fetchJson(method, `${baseUrl}/v1/file-sources${path}`, token, body);

/** Whether the file source's `zf_` schema exists. */
export const schemaExists = async (sourceId: string): Promise<boolean> => {
  const rows = await prisma.$queryRaw<Array<{ n: number }>>`
    SELECT 1 AS n FROM pg_namespace WHERE nspname = ${schemaFor(sourceId)}`;
  return rows.length > 0;
};

/** The table names in the file source's schema, sorted. */
export const storedTables = async (sourceId: string): Promise<string[]> => {
  const rows = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = ${schemaFor(sourceId)}
    ORDER BY tablename`;
  return rows.map((r) => r.tablename);
};

/** Removes the file sources these owners have, as `removeUploadSources` does, and their stagings. */
export const removeFileSourcesOf = async (ownerIds: string[]) => {
  const rows = await prisma.source.findMany({
    where: { ownerId: { in: ownerIds } },
    select: { id: true },
  });
  await removeUploadSources(rows.map((r) => r.id));
  const stagings = await prisma.fileStaging.findMany({
    where: { ownerId: { in: ownerIds } },
  });
  for (const s of stagings) {
    for (const t of s.tables as { stagingTable: string }[]) {
      await dropStagingTable(t.stagingTable);
    }
  }
  await prisma.fileStaging.deleteMany({ where: { ownerId: { in: ownerIds } } });
};

/**
 * A file source of `ownerId` made through `POST /v1/file-sources` on the app
 * at `baseUrl` from `csv`, keeping its one table as `table`; throws unless
 * it is created.
 */
export const createFileSource = async (
  baseUrl: string,
  token: string,
  ownerId: string,
  csv: string,
  {
    name = "File source",
    table = "data",
  }: { name?: string; table?: string } = {}
) => {
  const staged = await stageFile(ownerId, csv);
  const res = await fileSourcesCall(baseUrl, "POST", "", token, {
    staging_id: staged.stagingId,
    name,
    tables: [{ key: "csv", name: table }],
  });
  if (res.status !== 201) {
    throw new Error(`file source not created: ${JSON.stringify(res.body)}`);
  }
  return res.body as FileSourceBody;
};

export interface FileSourceBody {
  id: string;
  slug: string;
  name: string;
  owner_id: string;
  archived_at: string | null;
  stored_bytes: number;
  tables: {
    id: string;
    name: string;
    row_count: number;
    missing: boolean;
    last_synced_at: string | null;
    columns: {
      id: string;
      name: string;
      original_name: string | null;
      type: string;
      description: string | null;
      missing: boolean;
    }[];
  }[];
}
