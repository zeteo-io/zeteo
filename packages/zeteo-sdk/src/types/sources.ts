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
  type: SourceType;
  /** Redacted; null when the stored settings cannot be decrypted. */
  settings: Record<string, unknown> | null;
  schemas: string[];
  timeout_ms: number;
  row_cap: number;
  export_enabled: boolean;
  export_row_cap: number;
  query_concurrency: number;
  export_concurrency: number;
  writable_login_allowed: boolean;
  status: "active" | "unreachable";
  last_refreshed_at: string | null;
  created_at: string;
  archived_at: string | null;
}

interface CreateSourceFields {
  /** Matches `^[a-z][a-z0-9-]{1,62}$`. */
  slug: string;
  name: string;
  /** 1 to 20 schema names. */
  schemas: string[];
  allow_writable_login?: boolean;
  /** 1000 to 120000; the API's default is 30000. */
  timeout_ms?: number;
  /** 1 to 50000; the API's default is 50000. */
  row_cap?: number;
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

/** At least one field; `settings` replaces the whole settings object. */
export interface UpdateSourceRequest {
  name?: string;
  settings?: PostgresSettings | AzureSqlSettings;
  schemas?: string[];
  /** Accepted only together with `settings`. */
  allow_writable_login?: boolean;
  timeout_ms?: number;
  row_cap?: number;
  export_enabled?: boolean;
  export_row_cap?: number;
  query_concurrency?: number;
  export_concurrency?: number;
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

export interface Table {
  id: string;
  source_id: string;
  schema_name: string;
  name: string;
  kind: "table" | "view";
  description: string | null;
  last_seen_at: string;
  missing_since: string | null;
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

export interface ListSourcesOptions extends ListOptions {
  include_archived?: boolean;
}

export interface ListTablesOptions extends ListOptions {
  include_missing?: boolean;
}
