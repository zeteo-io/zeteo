import type { Source } from "../../prisma/generated/client/index.js";
import { readSettings } from "../sources/connect.js";
import { adapterFor } from "../adapters/index.js";
import { typeOf } from "../sources/types.js";

/** The settings as the adapter redacts them; null when the stored value cannot be read. */
const settingsView = (row: Source): Record<string, unknown> | null => {
  try {
    const adapter = adapterFor(typeOf(row));
    return adapter.redact(readSettings(adapter, row.id, row.sealedSettings));
  } catch {
    // readSettings has logged the cause.
    return null;
  }
};

export const sourceView = (row: Source) => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  type: typeOf(row),
  settings: settingsView(row),
  schemas: row.schemas,
  timeout_ms: row.timeoutMs,
  row_cap: row.rowCap,
  export_enabled: row.exportEnabled,
  export_row_cap: row.exportRowCap,
  writable_login_allowed: row.writableLoginAllowed,
  status: row.status,
  last_refreshed_at: row.lastRefreshedAt?.toISOString() ?? null,
  created_at: row.createdAt.toISOString(),
  archived_at: row.archivedAt?.toISOString() ?? null,
});

export type SourceView = ReturnType<typeof sourceView>;
