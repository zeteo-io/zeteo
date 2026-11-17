import type { SavedQuery } from "./types";
import { useCursorList } from "@/lib/api";

/** The saved queries the person owns, newest first. */
export const useMySavedQueries = () =>
  useCursorList<SavedQuery>(["saved-queries", "mine"], "/v1/saved-queries", {
    scope: "mine",
  });
