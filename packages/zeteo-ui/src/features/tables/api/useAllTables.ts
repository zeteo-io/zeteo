import { toApiError, useZeteoApi, type ApiError } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import type { AxiosInstance } from "axios";
import type { Table } from "./types";

export const tableLabel = (table: Pick<Table, "schema_name" | "name">) =>
  `${table.schema_name}.${table.name}`;

// The API's largest page.
const PAGE_LIMIT = 100;
export const MAX_PAGES = 50;

interface Page {
  data: Table[];
  next_cursor: string | null;
}

const loadAll = async (
  api: AxiosInstance,
  sourceId: string,
  includeMissing: boolean,
  signal: AbortSignal
): Promise<Table[]> => {
  const tables: Table[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    let body: Page;
    try {
      body = (
        await api.get<Page>(`/v1/sources/${sourceId}/tables`, {
          params: {
            limit: PAGE_LIMIT,
            ...(includeMissing ? { include_missing: true } : {}),
            ...(cursor ? { cursor } : {}),
          },
          signal,
        })
      ).data;
    } catch (err) {
      throw toApiError(err);
    }
    tables.push(...body.data);
    if (!body.next_cursor) return tables;
    cursor = body.next_cursor;
  }
  const tooMany: ApiError = {
    status: null,
    code: "too_many_tables",
    message: "This source has too many tables to list here.",
  };
  throw tooMany;
};

/**
 * Every table of a source, for resolving ids to names and choosing tables:
 * one query that reads the pages itself, failing once rather than retrying.
 */
export const useAllTables = (
  sourceId: string | undefined,
  { includeMissing = true }: { includeMissing?: boolean } = {}
) => {
  const api = useZeteoApi();
  const query = useQuery<Table[], ApiError>({
    queryKey: ["sources", sourceId, "tables", "all", { includeMissing }],
    enabled: sourceId !== undefined,
    retry: false,
    queryFn: ({ signal }) =>
      loadAll(api, sourceId as string, includeMissing, signal),
  });
  const tables = query.data ?? [];
  const byId = new Map(tables.map((t) => [t.id, t]));
  return {
    tables,
    isLoading: query.isLoading,
    error: query.error,
    /** `schema.name`, or the raw id while the table is not (yet) known. */
    labelFor: (id: string) => {
      const table = byId.get(id);
      return table ? tableLabel(table) : id;
    },
  };
};
