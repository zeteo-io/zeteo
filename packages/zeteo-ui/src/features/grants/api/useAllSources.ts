import type { Source } from "@/features/sources";
import { useCursorList } from "@/lib/api";
import { useEffect } from "react";

/**
 * Every source, archived ones included, read page after page. Switched off
 * (`enabled`) for someone without `zeteo.sources.read`, whose request would
 * only be refused.
 */
export const useAllSources = (enabled: boolean) => {
  const { items, isLoading, error, hasMore, loadMore } = useCursorList<Source>(
    ["sources"],
    "/v1/sources",
    { include_archived: true },
    { enabled }
  );
  useEffect(() => {
    if (hasMore) loadMore();
  }, [hasMore, items.length, loadMore]);
  return {
    sources: items,
    isLoading: enabled && (isLoading || hasMore),
    error,
  };
};
