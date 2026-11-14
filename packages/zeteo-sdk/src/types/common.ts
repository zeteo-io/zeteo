export interface Page<T> {
  data: T[];
  next_cursor: string | null;
}

export interface ListOptions {
  /** 1 to 100; the API's default is 50. */
  limit?: number;
  /** The `next_cursor` of the previous page; omit it for the first. */
  cursor?: string;
}

/** The normalised type; `native_type` keeps the database's own name. */
export type ColumnType =
  "text" | "number" | "boolean" | "date" | "timestamp" | "json" | "other";

export type PrincipalType = "user" | "group";

export type SourceType = "postgres" | "azure-sql";

export interface HealthStatus {
  status: "ok" | "degraded";
  postgres: "ok" | "fail";
  redis: "ok" | "fail";
}
