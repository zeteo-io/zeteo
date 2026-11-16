import { toApiError, useZeteoApi, type ApiError } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import type { AxiosInstance } from "axios";
import type { Source } from "./types";

// The API's largest page.
const PAGE_LIMIT = 100;
export const MAX_PAGES = 50;

interface Page {
  data: Source[];
  next_cursor: string | null;
}

const loadAll = async (
  api: AxiosInstance,
  signal: AbortSignal
): Promise<Source[]> => {
  const sources: Source[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    let body: Page;
    try {
      body = (
        await api.get<Page>("/v1/sources", {
          params: {
            limit: PAGE_LIMIT,
            include_archived: true,
            ...(cursor ? { cursor } : {}),
          },
          signal,
        })
      ).data;
    } catch (err) {
      throw toApiError(err);
    }
    sources.push(...body.data);
    if (!body.next_cursor) return sources;
    cursor = body.next_cursor;
  }
  const tooMany: ApiError = {
    status: null,
    code: "too_many_sources",
    message: "There are too many sources to list here.",
  };
  throw tooMany;
};

/**
 * Every source, archived ones included: one query that reads the pages
 * itself, failing once rather than retrying. Switched off (`enabled`) for
 * someone without `zeteo.sources.read`, whose request would only be refused.
 */
export const useAllSources = (enabled: boolean) => {
  const api = useZeteoApi();
  const query = useQuery<Source[], ApiError>({
    queryKey: ["sources", "all", { includeArchived: true }],
    enabled,
    retry: false,
    queryFn: ({ signal }) => loadAll(api, signal),
  });
  return {
    sources: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
  };
};
