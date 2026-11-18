import type {
  Source,
  SourceColumn,
  SourceTable,
} from "../../prisma/generated/client/index.js";

export type FileSourceRow = Source & {
  tables: (SourceTable & { columns: SourceColumn[] })[];
};

/**
 * A file source as its owner and admins see it: its tables, with the
 * missing ones (removed, or of a deleted source) flagged, and their columns.
 * Never any cell of its data.
 */
export const fileSourceView = (row: FileSourceRow, storedBytes: number) => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  type: "upload" as const,
  owner_id: row.ownerId,
  created_at: row.createdAt.toISOString(),
  archived_at: row.archivedAt?.toISOString() ?? null,
  stored_bytes: storedBytes,
  tables: row.tables.map((t) => ({
    id: t.id,
    name: t.name,
    row_count: t.rowCount ?? 0,
    last_synced_at: t.lastSyncedAt?.toISOString() ?? null,
    missing: t.missingSince !== null,
    columns: t.columns.map((c) => ({
      id: c.id,
      name: c.name,
      original_name: c.originalName,
      type: c.type,
      description: c.description,
      missing: c.missingSince !== null,
    })),
  })),
});

export type FileSourceView = ReturnType<typeof fileSourceView>;
