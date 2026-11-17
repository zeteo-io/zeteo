import type { SavedQuery } from "./types";
import { useCursorList } from "@/lib/api";

export interface AllSavedQueryFilters {
  owner_id?: string;
  source_id?: string;
  q?: string;
}

/** Every saved query (needs `zeteo.saved_queries.read`), newest first, narrowed by the filters. */
export const useAllSavedQueries = (filters: AllSavedQueryFilters = {}) =>
  useCursorList<SavedQuery>(["saved-queries", "all"], "/v1/saved-queries", {
    scope: "all",
    ...filters,
  });
