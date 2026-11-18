// Field for field the OpenAPI `Source`, `CreateSourceRequest`,
// `UpdateSourceRequest`, `TestSourceResponse` and `RefreshSummary` schemas.

export type SourceType = "postgres" | "azure-sql" | "upload";

/** The types a person registers a database source with; `upload` sources come from File Sources. */
export type DatabaseType = Exclude<SourceType, "upload">;

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

export interface Source {
  id: string;
  slug: string;
  name: string;
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
  /** A file source's owner; null for a database source. */
  owner_id?: string | null;
  status: "active" | "unreachable";
  last_refreshed_at: string | null;
  created_at: string;
  archived_at: string | null;
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
  type: SourceType;
  settings: SourceSettings;
  schemas: string[];
  allow_writable_login?: boolean;
}

export interface UpdateSource extends SourceLimits {
  name?: string;
  settings?: SourceSettings;
  schemas?: string[];
  /** Accepted only together with `settings`. */
  allow_writable_login?: boolean;
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
