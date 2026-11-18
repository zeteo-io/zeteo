import type { FileColumnType } from "../../file-sources/types.js";
import { removeSources, uniqueSlug } from "./sources.js";
import { prisma } from "../../utils/db/prisma.js";
import type { SeededSource } from "./queries.js";
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
