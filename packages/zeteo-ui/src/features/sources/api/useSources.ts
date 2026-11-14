import { useCursorList } from "@/lib/api";
import type { Source } from "./types";

/** Sources in creation order; archived ones only when asked for. */
export const useSources = ({
  includeArchived = false,
}: { includeArchived?: boolean } = {}) =>
  useCursorList<Source>(["sources"], "/v1/sources", {
    include_archived: includeArchived ? true : undefined,
  });
