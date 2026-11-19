import type { ColumnType, ListOptions, SourceType } from "./common.js";
import type { UploadColumnType } from "./uploads.js";

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
  /**
   * An upload source with Google Sheets tables: their sync state. Only in the
   * view of its owner or of `zeteo.sources.read`; absent otherwise.
   */
  sync?: SourceSync;
}

/** A Google Sheets table whose last sync failed. */
export interface FailingTable {
  table_id: string;
  name: string;
  /** An error code such as `sheet_not_accessible`, `google_unavailable` or `sync_failed`. */
  code: string;
  message: string;
}

export interface SourceSync {
  /** 15 to 1440. */
  interval_minutes: number;
  /** The last sync tried, good or not; null before one. */
  last_attempt_at: string | null;
  /** The Sheets tables whose last sync failed; empty when all are good. */
  failing: FailingTable[];
  /** A table fails and has had no good sync for over 24 hours. */
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
 * source's owner may change only `name`, `description` and `sync_interval_minutes`.
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
  /** An upload source only (15 to 1440); `422 not_synced` on a database source. */
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

/** A sync's error for one table, as `error` and `sync_error` carry it. */
export interface TableSyncError {
  code: string;
  message: string;
}

/** What a sync of an upload source's Google Sheets tables did (Sync now). */
export interface SyncSummary {
  synced_at: string;
  tables: {
    id: string;
    name: string;
    row_count: number;
    /** The tab is no longer in the spreadsheet; the table keeps its last data. */
    missing: boolean;
    /** Why this table did not sync; null when it did. */
    error: TableSyncError | null;
  }[];
}

/** Where an upload source's table comes from. */
export type TableOrigin =
  | { kind: "file"; filename: string }
  | {
      kind: "google-sheets";
      spreadsheet_id: string;
      spreadsheet_title: string;
      /** Opens the tab. */
      url: string;
      /** The tab's `sheetId`. */
      tab_id: number;
      /** The tab's title; absent on a table made before it was kept. */
      tab_title?: string;
    }
  | { kind: "merged"; /** The number of member tables. */ members: number };

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
  /** An upload source's table: when it was last loaded (a Sheets table's last good sync); null for a database source's. */
  last_loaded_at: string | null;
  /** An upload source's table: where it comes from; null for a database source's. */
  origin: TableOrigin | null;
  /** A Google Sheets table's last failed sync; null when it is good. Seen by the source's owner and `zeteo.sources.read` only. */
  sync_error: TableSyncError | null;
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
  /** A merged table's definition and state; absent on any other table. */
  merged?: MergedDetail;
}

/** A merged table's definition (`PUT .../merged`, `POST .../merged-tables`). */
export interface MergedTableRequest {
  /** Lowercase letters, digits and `_`, starting with a letter; at most 63 bytes. */
  name: string;
  /** The column that names each row's member; same rule as `name`. */
  label_column: string;
  /** 2 to 100 tables of the source that are not merged. */
  members: { table_id: string; label: string }[];
  /** 1 to 1600; each member column by its `from_name`, the included ones becoming `name`. */
  columns: { name: string; from_name: string; include: boolean }[];
}

export interface MergedMember {
  table_id: string;
  name: string;
  label: string;
  /** The member table is missing; its rows are gone. */
  missing: boolean;
}

export interface MergedColumn {
  id: string;
  name: string;
  /** The member columns' name this column reads. */
  from_name: string;
  type: UploadColumnType;
  /** The live members that have it. */
  members: string[];
  missing: boolean;
}

/** A merged table's detail, on `TableDetail.merged`. */
export interface MergedDetail {
  label_column: string;
  members: MergedMember[];
  columns: MergedColumn[];
  /** Member columns the merged table does not carry. */
  available: { name: string; type: UploadColumnType; members: string[] }[];
  /** Member columns that no longer fit their merged column's type. */
  warnings: { column_id: string; table_id: string }[];
}

/** The columns the members would give a merged table, and a suggested label per member. */
export interface MergedColumnsResponse {
  columns: {
    name: string;
    /** `text` when the members' types disagree. */
    type: UploadColumnType;
    /** The members' distinct types, sorted. */
    types: ColumnType[];
    /** The members that have it. */
    members: string[];
  }[];
  /** A member table's id to its suggested label. */
  labels: Record<string, string>;
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
