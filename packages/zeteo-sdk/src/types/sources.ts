import type { ColumnType, ListOptions, SourceType } from "./common.js";

export interface PostgresSettings {
  host: string;
  /** 1 to 65535; the API's default is 5432. */
  port?: number;
  database: string;
  user: string;
  password: string;
  /** The API's default is `verify`. */
  tls?: "verify" | "require" | "off";
  ca?: string;
}

export interface AzureSqlSettings {
  host: string;
  /** 1 to 65535; the API's default is 1433. */
  port?: number;
  database: string;
  user: string;
  password: string;
  /** The API's default is `verify`. */
  tls?: "verify" | "trust-server-certificate";
}

export type LoginFindingCode =
  | "superuser"
  | "can_create_roles"
  | "can_create_databases"
  | "bypasses_row_security"
  | "owns_objects"
  | "can_write_tables"
  | "can_create_in_schema"
  | "write_role_member"
  | "replication"
  | "reads_server_files";

export interface LoginFinding {
  code: LoginFindingCode;
  detail: string;
}

export interface Source {
  id: string;
  slug: string;
  name: string;
  /** What the source holds; empty when none was given. */
  description: string;
  type: SourceType;
  /** An upload source's owner; null for a database source. */
  owner_id: string | null;
  /** Redacted; null for an upload source or when the stored settings cannot be decrypted. */
  settings: Record<string, unknown> | null;
  schemas: string[];
  timeout_ms: number;
  row_cap: number;
  max_joins: number;
  export_enabled: boolean;
  export_row_cap: number;
  query_concurrency: number;
  export_concurrency: number;
  writable_login_allowed: boolean;
  status: "active" | "unreachable";
  last_refreshed_at: string | null;
  /**
   * A database source: bytes on disk of the tables in `schemas`, measured by
   * the last catalogue refresh; null before the first refresh, or when the
   * source would not tell. An upload source: the bytes it stores now.
   */
  size_bytes: number | null;
  /** When a database source's `size_bytes` was measured; null for an upload source. */
  size_measured_at: string | null;
  /** How many people and groups its tables are granted to, an upload source's owner grants not counted. */
  share_count: number;
  created_at: string;
  archived_at: string | null;
  /** A Google Sheets source's spreadsheet; absent on any other type. */
  sheet?: SourceSheet;
  /** A Google Sheets source's sync state; absent on any other type. */
  sync?: SourceSync;
}

export interface SourceSheet {
  spreadsheet_id: string;
  url: string;
}

export interface SourceSync {
  /** 15 to 1440. */
  interval_minutes: number;
  /** The last sync tried, good or not. */
  last_attempt_at: string | null;
  /** Why the last sync failed; null after a good one. */
  last_error: { code: string; message: string } | null;
  /** The last sync failed and the last good one is over 24 hours old or never happened. */
  stale: boolean;
}

interface CreateSourceFields {
  /** Matches `^[a-z][a-z0-9-]{1,62}$`. */
  slug: string;
  name: string;
  /** What the source holds, at most 500 characters; trimmed. */
  description?: string;
  /** 1 to 20 schema names. */
  schemas: string[];
  allow_writable_login?: boolean;
  /** 1000 to 120000; the API's default is 30000. */
  timeout_ms?: number;
  /** 1 to 50000; the API's default is 50000. */
  row_cap?: number;
  /** 1 to 8; the API's default is 4. */
  max_joins?: number;
  export_enabled?: boolean;
  /** 0 to 1000000; the API's default is 0. */
  export_row_cap?: number;
  /** 1 to 50; the API's default is 5. */
  query_concurrency?: number;
  /** 1 to 10; the API's default is 2. */
  export_concurrency?: number;
}

export type CreateSourceRequest = CreateSourceFields &
  (
    | { type: "postgres"; settings: PostgresSettings }
    | { type: "azure-sql"; settings: AzureSqlSettings }
  );

/**
 * At least one field; `settings` replaces the whole settings object. An upload
 * source's owner may change only `name` and `description`.
 */
export interface UpdateSourceRequest {
  name?: string;
  /** At most 500 characters; trimmed; empty clears it. */
  description?: string;
  settings?: PostgresSettings | AzureSqlSettings;
  schemas?: string[];
  /** Accepted only together with `settings`. */
  allow_writable_login?: boolean;
  timeout_ms?: number;
  row_cap?: number;
  max_joins?: number;
  export_enabled?: boolean;
  export_row_cap?: number;
  query_concurrency?: number;
  export_concurrency?: number;
  /** A Google Sheets source only (15 to 1440); `422 not_synced` on any other. */
  sync_interval_minutes?: number;
}

export interface TestSourceResponse {
  ok: true;
  findings: LoginFinding[];
  truncated?: true;
}

export interface RefreshCounts {
  added: number;
  missing: number;
  restored: number;
}

export interface RefreshSummary {
  tables: RefreshCounts;
  columns: RefreshCounts & { changed: number };
  relations: RefreshCounts;
}

/** What a sync of a Google Sheets source did. */
export interface SyncSummary {
  synced_at: string;
  tables: { id: string; name: string; row_count: number; missing: boolean }[];
}

export interface Table {
  id: string;
  source_id: string;
  schema_name: string;
  name: string;
  kind: "table" | "view";
  description: string | null;
  last_seen_at: string;
  missing_since: string | null;
  /**
   * An upload source's table: the rows loaded. A database source's: an
   * estimate from the database's statistics at the last refresh, not a count;
   * null for a view or a table the database has no estimate for.
   */
  row_count: number | null;
  /** An upload or Sheets source's table: when it was last loaded (a Sheets table's last good sync); null for a database source's. */
  last_loaded_at: string | null;
}

export interface Column {
  id: string;
  name: string;
  type: ColumnType;
  /** The type as the database writes it. */
  native_type: string;
  nullable: boolean;
  position: number;
  is_primary_key: boolean;
  description: string | null;
  /** An upload source's column: its header in the file; null for a database source's. */
  original_name: string | null;
  missing_since: string | null;
}

export interface Relation {
  id: string;
  name: string;
  from_table_id: string;
  from_columns: string[];
  to_table_id: string;
  to_columns: string[];
  to_many: boolean;
  origin: "discovered" | "declared";
  missing_since: string | null;
}

export interface TableDetail extends Table {
  columns: Column[];
  relations: Relation[];
}

/** At least one field; `null` clears a description. */
export interface PatchTableRequest {
  description?: string | null;
  columns?: { name: string; description: string | null }[];
}

export interface DeclareRelationRequest {
  /** Matches `^[a-z][a-z0-9_]{0,62}$`. */
  name: string;
  from_table_id: string;
  from_columns: string[];
  to_table_id: string;
  to_columns: string[];
  to_many: boolean;
}

export interface RenameRelationRequest {
  /** Matches `^[a-z][a-z0-9_]{0,62}$`. */
  name: string;
}

export interface ListSourcesOptions extends ListOptions {
  include_archived?: boolean;
  type?: SourceType;
  /** `me` for the caller's own upload sources (all an owner without `zeteo.sources.read` may list), or a user's id. */
  owner_id?: string;
}

export interface ListTablesOptions extends ListOptions {
  include_missing?: boolean;
}
