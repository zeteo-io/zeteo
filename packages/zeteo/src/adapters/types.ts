import type { VisibleCatalog, VisibleTable } from "../grants/visibleCatalog.js";
import type { ResolvedTarget } from "../sources/network.js";
import type { z } from "zod";

export type SourceType = "postgres" | "azure-sql";
export type ColumnType =
  "text" | "number" | "boolean" | "date" | "timestamp" | "json" | "other";

export interface LoginFinding {
  code:
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
  detail: string;
}

export interface SnapshotColumn {
  name: string;
  type: ColumnType;
  nativeType: string;
  nullable: boolean;
  position: number;
  isPrimaryKey: boolean;
}
export interface SnapshotTable {
  schemaName: string;
  name: string;
  kind: "table" | "view";
  columns: SnapshotColumn[];
}
export interface SnapshotForeignKey {
  constraintName: string;
  from: { schemaName: string; table: string; columns: string[] };
  to: { schemaName: string; table: string; columns: string[] };
}
export interface SchemaSnapshot {
  tables: SnapshotTable[];
  foreignKeys: SnapshotForeignKey[];
}

/** What one run may use; `maxRows` is the effective row limit. */
export interface RunLimits {
  maxRows: number;
  /** The most bytes of the rows as JSON. */
  maxBytes: number;
  timeoutMs: number;
  /** `performance.now()` value by which the run must have ended. */
  deadlineAt: number;
}

/**
 * A plan compiled for one source type, ready to run on that type's
 * connections. Opaque beyond the plan: each adapter narrows its own.
 */
export interface PreparedQuery {
  readonly plan: QueryPlan;
}

export interface QueryResult {
  /** `plan.columns` by position. */
  columns: { name: string; type: ColumnType }[];
  /** Values in their wire forms. */
  rows: unknown[][];
  /** Why rows were left out, if any were: more than `maxRows`, or past `maxBytes`. */
  truncated: false | "rows" | "bytes";
}

export interface SourceConnection {
  /** Inspects the login across the whole connected database, not a schema list. */
  checkLogin(): Promise<LoginFinding[]>;
  readSchema(schemas: string[]): Promise<SchemaSnapshot>;
  /**
   * Runs a query prepared by this source's own adapter, read-only and within
   * `limits`, ending by `limits.deadlineAt` however long it waited for a
   * connection. Throws `QueryTimeoutError`, `QueryFailedError` or
   * `SourceUnreachableError`; when `signal` aborts, stops the query on the
   * source and rejects with the signal's reason. Throws an `Error` for a
   * query another adapter prepared.
   */
  runQuery(
    prepared: PreparedQuery,
    limits: RunLimits,
    signal?: AbortSignal
  ): Promise<QueryResult>;
  close(): Promise<void>;
}

export interface ConnectOptions {
  connectTimeoutMs: number;
  poolSize: number;
  /** Longest a catalog query may run, enforced by the client and the server. */
  queryTimeoutMs: number;
}

/** A catalogue column a query touches. */
export interface Reference {
  tableId: string;
  columnId: string;
}

export interface OutputColumn {
  name: string;
  type: ColumnType;
  /** The columns the value is computed from; none for `count(*)`. */
  references: Reference[];
}

export interface QueryWarning {
  code: "join_multiplies_rows";
  message: string;
  path: (string | number)[];
}

/** What every language's plan tells the engine, whatever the source family. */
export interface QueryPlan {
  /** Every column the query touches anywhere, join keys included, each once. */
  references: Reference[];
  /** The result's columns, in order. */
  columns: OutputColumn[];
  warnings: QueryWarning[];
  /** As the query asked; the engine applies its own default and maximum. */
  limit: number | undefined;
  offset: number;
}

export interface QueryLanguage<Q = unknown, P extends QueryPlan = QueryPlan> {
  id: string;
  schema: z.ZodType<Q>;
  /** JSON Schema of `schema`, for the catalogue and the AI. */
  describe(): unknown;
  /** Resolves a parsed query against what the caller may see; throws `QueryError`. */
  plan(query: Q, catalog: VisibleCatalog): P;
  /** The name a query uses for `table` among `tables`. */
  tableName(tables: VisibleTable[], table: VisibleTable): string;
}

export interface SourceAdapter<S = unknown> {
  type: SourceType;
  settingsSchema: z.ZodType<S>;
  language: QueryLanguage;
  /** The host a source's settings point at, for the network rules. */
  hostOf(settings: S): string;
  /** Settings safe to return from the API. */
  redact(settings: S): Record<string, unknown>;
  connect(
    settings: S,
    target: ResolvedTarget,
    options: ConnectOptions
  ): Promise<SourceConnection>;
  /** Compiles a plan for this source type; throws `QueryError` (e.g. `too_many_parameters`). No I/O. */
  prepare(
    plan: QueryPlan,
    rows: { limit: number; offset: number }
  ): PreparedQuery;
}
