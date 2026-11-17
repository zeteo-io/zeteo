import type { SavedQuery } from "@/features/saved-queries";
import { useCursorList } from "@/lib/api";

/** Other people's saved queries made available for dashboards. */
export const useAvailableSavedQueries = () =>
  useCursorList<SavedQuery>(
    ["saved-queries", "available"],
    "/v1/saved-queries",
    { scope: "available" }
  );
