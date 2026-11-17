import { toApiError, useZeteoApi, type ApiError } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import type { Relation } from "./types";

// The API's largest page, and a ceiling so a runaway catalogue fails once.
const PAGE_LIMIT = 100;
export const MAX_PAGES = 50;

interface Page {
  data: Relation[];
  next_cursor: string | null;
}

/**
 * Every relation of a source, missing ones included, for filtering in the
 * browser: one query that reads the pages itself.
 */
export const useAllRelations = (sourceId: string) => {
  const api = useZeteoApi();
  const query = useQuery<Relation[], ApiError>({
    // Under the key useDeleteRelation and useDeclareRelation invalidate.
    queryKey: ["sources", sourceId, "relations", "all"],
    retry: false,
    queryFn: async ({ signal }) => {
      const relations: Relation[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        let body: Page;
        try {
          body = (
            await api.get<Page>(`/v1/sources/${sourceId}/relations`, {
              params: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
              signal,
            })
          ).data;
        } catch (err) {
          throw toApiError(err);
        }
        relations.push(...body.data);
        if (!body.next_cursor) return relations;
        cursor = body.next_cursor;
      }
      throw {
        status: null,
        code: "too_many_relations",
        message: "This source has too many relations to list here.",
      } satisfies ApiError;
    },
  });
  return {
    relations: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
  };
};
