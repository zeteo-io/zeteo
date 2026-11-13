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

export interface SourceConnection {
  /** Inspects the login across the whole connected database, not a schema list. */
  checkLogin(): Promise<LoginFinding[]>;
  readSchema(schemas: string[]): Promise<SchemaSnapshot>;
  close(): Promise<void>;
}

export interface ConnectOptions {
  connectTimeoutMs: number;
  poolSize: number;
  /** Longest a catalog query may run, enforced by the client and the server. */
  queryTimeoutMs: number;
}

export interface SourceAdapter<S = unknown> {
  type: SourceType;
  settingsSchema: z.ZodType<S>;
  /** The host a source's settings point at, for the network rules. */
  hostOf(settings: S): string;
  /** Settings safe to return from the API. */
  redact(settings: S): Record<string, unknown>;
  connect(
    settings: S,
    target: ResolvedTarget,
    options: ConnectOptions
  ): Promise<SourceConnection>;
}
