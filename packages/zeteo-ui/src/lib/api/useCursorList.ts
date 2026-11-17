// Query keys: a list's key starts with its resource path so a mutation can
// invalidate by prefix. `["sources"]` is the list of sources;
// `["sources", id]` one source; `["sources", id, "tables"]` its tables;
// `["sources", id, "tables", tableId, "columns"]` and so on down. Invalidating
// `["sources", id]` therefore refreshes the source and everything under it.
import { useInfiniteQuery } from "@tanstack/react-query";
import { toApiError, type ApiError } from "./errors";
import { useZeteoApi } from "./client";
import { useMemo } from "react";

const PAGE_SIZE = 50;

interface Page<T> {
  data: T[];
  next_cursor: string | null;
}

export type ListParams = Record<string, string | boolean | undefined>;

const definedOnly = (params: ListParams) =>
  Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined)
  );

/** A list endpoint answering `{ data, next_cursor }`, read a page at a time. */
export const useCursorList = <T>(
  key: unknown[],
  path: string,
  params: ListParams = {},
  opts: { enabled?: boolean } = {}
) => {
  const api = useZeteoApi();
  const query = useInfiniteQuery({
    queryKey: [...key, params],
    enabled: opts.enabled ?? true,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const res = await api
        .get<Page<T>>(path, {
          params: {
            ...definedOnly(params),
            limit: PAGE_SIZE,
            ...(pageParam ? { cursor: pageParam } : {}),
          },
        })
        .catch((err: unknown) => {
          throw toApiError(err);
        });
      return res.data;
    },
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });

  // A list that changes between page loads can repeat a row on the next page.
  const items = useMemo(() => {
    const seen = new Set<unknown>();
    return (query.data?.pages ?? []).flatMap((page) =>
      page.data.filter((item) => {
        const id = (item as { id?: unknown } | null)?.id;
        if (typeof id !== "string") return true;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      })
    );
  }, [query.data]);
  return {
    items,
    isLoading: query.isLoading,
    error: (query.error as ApiError | null) ?? null,
    hasMore: query.hasNextPage,
    loadMore: () => {
      if (query.hasNextPage && !query.isFetchingNextPage) {
        void query.fetchNextPage();
      }
    },
    refetch: () => {
      void query.refetch();
    },
  };
};
