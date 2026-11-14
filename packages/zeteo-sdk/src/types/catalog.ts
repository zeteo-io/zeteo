import type { ColumnType, SourceType } from "./common.js";

export interface GetCatalogOptions {
  /** The slug of one source. */
  source?: string;
}

export interface DiscoveredColumn {
  name: string;
  type: ColumnType;
  nullable: boolean;
  description: string | null;
  /** The last refresh did not find the column; a query using it fails with `missing_in_source`. */
  missing: boolean;
}

export interface DiscoveredRelation {
  /** What a query's `join` names. */
  name: string;
  /** The target table as a query writes it in `from`. */
  to: string;
  /** One row can match several, so aggregates over the join may count a row more than once. */
  to_many: boolean;
  missing: boolean;
}

export interface DiscoveredTable {
  /** As a query writes it in `from`. */
  name: string;
  schema_name: string;
  kind: "table" | "view";
  description: string | null;
  missing: boolean;
  columns: DiscoveredColumn[];
  relations: DiscoveredRelation[];
}

export interface DiscoveredSource {
  /** What a query's `source` names. */
  slug: string;
  name: string;
  type: SourceType;
  language: {
    id: "sql";
    /** The JSON Schema a query's body must satisfy. */
    schema: Record<string, unknown>;
  };
  limits: {
    /** Rows when the query sets no `limit`. */
    default_rows: number;
    /** The most a `limit` may ask for. */
    max_rows: number;
    timeout_ms: number;
    export: {
      enabled: boolean;
      /** The source's `export_row_cap`; 0 when exports are off. */
      max_rows: number;
    };
  };
  tables: DiscoveredTable[];
}

export interface Catalog {
  sources: DiscoveredSource[];
}
