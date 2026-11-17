import type { SavedQuery } from "./types";
import { useCursorList } from "@/lib/api";

/** The saved queries others shared with the person, newest first. */
export const useSharedSavedQueries = () =>
  useCursorList<SavedQuery>(["saved-queries", "shared"], "/v1/saved-queries", {
    scope: "shared",
  });
