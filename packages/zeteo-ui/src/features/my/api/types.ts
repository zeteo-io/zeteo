import type { Run } from "@/features/runs/api/types";

/** A run in `GET /v1/me/runs`: the admin run plus the saved query it came from. */
export interface MyRun extends Run {
  saved_query?: { id: string; name: string };
}

export interface CatalogTable {
  name: string;
  schema_name?: string;
  kind: string;
  description?: string | null;
}

export interface CatalogSource {
  slug: string;
  name: string;
  type: string;
  tables: CatalogTable[];
}

/** True for the placeholder of a run whose query could not be recorded. */
export const isUnrecordable = (query: unknown): boolean =>
  typeof query === "object" &&
  query !== null &&
  (query as { unrecordable?: unknown }).unrecordable === true;

/** True for the placeholder a refused saved-query run carries instead of its JSON. */
export const isWithheld = (query: unknown): boolean =>
  typeof query === "object" &&
  query !== null &&
  (query as { withheld?: unknown }).withheld === true;
