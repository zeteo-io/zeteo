import type { Source } from "../../prisma/generated/client/index.js";
import { isUploadSource, typeOf } from "../sources/types.js";
import { readSettings } from "../sources/connect.js";
import { adapterFor } from "../adapters/index.js";
import { logger } from "../utils/logger.js";

/**
 * The settings as the adapter redacts them; null, with the cause logged, when
 * the type has no adapter or the stored value cannot be read, so the source
 * can still be listed and viewed. An upload source has none: Zeteo holds its data.
 */
const settingsView = (row: Source): Record<string, unknown> | null => {
  if (isUploadSource(row)) return null;
  try {
    const adapter = adapterFor(typeOf(row));
    return adapter.redact(readSettings(adapter, row.id, row.sealedSettings));
  } catch (err) {
    logger.error({ err, source_id: row.id }, "source settings cannot be shown");
    return null;
  }
};

/** What a source's view needs besides its row, loaded by `sources/present.ts`. */
export interface SourceViewExtras {
  /** The people and groups its tables are shared with, the owner's own grants not counted. */
  shareCount: number;
  /** An upload source's stored bytes now (0 once deleted); unused for a database source. */
  storedBytes: number;
  /** An upload source: its latest load, which it reports as its last refresh. */
  lastLoadedAt?: Date | null;
}

export const sourceView = (row: Source, extras: SourceViewExtras) => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  type: typeOf(row),
  settings: settingsView(row),
  schemas: row.schemas,
  timeout_ms: row.timeoutMs,
  row_cap: row.rowCap,
  max_joins: row.maxJoins,
  export_enabled: row.exportEnabled,
  export_row_cap: row.exportRowCap,
  query_concurrency: row.queryConcurrency,
  export_concurrency: row.exportConcurrency,
  writable_login_allowed: row.writableLoginAllowed,
  /** An upload source's owner; null for a database source. */
  owner_id: row.ownerId,
  status: row.status,
  // A database source's last catalogue refresh; an upload source's last load
  // (it has no refresh: its data changes when a file is loaded).
  last_refreshed_at:
    (extras.lastLoadedAt !== undefined
      ? extras.lastLoadedAt
      : row.lastRefreshedAt
    )?.toISOString() ?? null,
  /**
   * A database source: bytes on disk of the tables in `schemas` at the last
   * refresh, null when the source would not tell. An upload source: the bytes
   * it stores now.
   */
  size_bytes: isUploadSource(row)
    ? extras.storedBytes
    : row.sizeBytes === null
      ? null
      : Number(row.sizeBytes),
  /** When a database source's size was measured; null for an upload source. */
  size_measured_at: isUploadSource(row)
    ? null
    : (row.sizeMeasuredAt?.toISOString() ?? null),
  share_count: extras.shareCount,
  created_at: row.createdAt.toISOString(),
  archived_at: row.archivedAt?.toISOString() ?? null,
});

export type SourceView = ReturnType<typeof sourceView>;
