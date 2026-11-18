// Field for field the OpenAPI `Source`, `CreateSourceRequest`,
// `UpdateSourceRequest`, `TestSourceResponse` and `RefreshSummary` schemas.

export type SourceType = "postgres" | "azure-sql" | "upload" | "google-sheets";

/** The types a person registers a database source with; an upload source is made from a file or a Google Sheet. */
export type DatabaseType = Exclude<SourceType, "upload" | "google-sheets">;

export interface PostgresSettings {
  host: string;
  port?: number;
  database: string;
  user: string;
  password: string;
  tls?: "verify" | "require" | "off";
  ca?: string;
}

export interface AzureSqlSettings {
  host: string;
  port?: number;
  database: string;
  user: string;
  password: string;
  tls?: "verify" | "trust-server-certificate";
}

export type SourceSettings = PostgresSettings | AzureSqlSettings;

/** A Google Sheets source's spreadsheet; only its owner and `zeteo.sources.read` see it. */
export interface SheetInfo {
  spreadsheet_id: string;
  url: string;
}

/** A Google Sheets source's sync state; `last_refreshed_at` is the last successful sync. */
export interface SyncInfo {
  interval_minutes: number;
  last_attempt_at: string | null;
  last_error: { code: string; message: string } | null;
  stale: boolean;
}

export interface Source {
  id: string;
  slug: string;
  name: string;
  /** What the source holds, up to 500 characters; "" when unset. */
  description: string;
  type: SourceType;
  /** Redacted (no `password`, no `ca`); null when the stored settings cannot be decrypted. */
  settings: Record<string, unknown> | null;
  schemas: string[];
  timeout_ms: number;
  row_cap: number;
  export_enabled: boolean;
  export_row_cap: number;
  query_concurrency: number;
  export_concurrency: number;
  writable_login_allowed: boolean;
  /** An upload source's owner; null for a database source. */
  owner_id: string | null;
  status: "active" | "unreachable";
  last_refreshed_at: string | null;
  /**
   * A database source: the tables of its schemas on disk, measured at the
   * last refresh, null when it could not be read. An upload: its stored bytes.
   */
  size_bytes: number | null;
  /** When a database source's size was measured; null for an upload. */
  size_measured_at: string | null;
  /** People and groups its tables are shared with, an upload owner's own grants not counted. */
  share_count: number;
  created_at: string;
  archived_at: string | null;
  /** A Google Sheets source only. */
  sheet?: SheetInfo;
  /** A Google Sheets source only. */
  sync?: SyncInfo;
}

interface SourceLimits {
  timeout_ms?: number;
  row_cap?: number;
  export_enabled?: boolean;
  export_row_cap?: number;
  query_concurrency?: number;
  export_concurrency?: number;
}

export interface CreateSource extends SourceLimits {
  slug: string;
  name: string;
  description?: string;
  type: SourceType;
  settings: SourceSettings;
  schemas: string[];
  allow_writable_login?: boolean;
}

/** An upload's owner may send only `name` and `description`; a sources admin the limits too. */
export interface UpdateSource extends SourceLimits {
  name?: string;
  description?: string;
  settings?: SourceSettings;
  schemas?: string[];
  /** Accepted only together with `settings`. */
  allow_writable_login?: boolean;
  /** A Google Sheets source: minutes between syncs, 15 to 1440. */
  sync_interval_minutes?: number;
}

export interface LoginFinding {
  code: string;
  detail: string;
}

export interface TestResult {
  ok: true;
  findings: LoginFinding[];
  truncated?: true;
}

export interface RefreshSummary {
  tables: { added: number; missing: number; restored: number };
  columns: {
    added: number;
    changed: number;
    missing: number;
    restored: number;
  };
  relations: { added: number; missing: number; restored: number };
}
