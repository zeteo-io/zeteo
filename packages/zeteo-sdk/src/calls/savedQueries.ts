import { exportMethods, type ExportRows, type ExportStream } from "./export.js";
import type { QueryResult } from "../types/query.js";
import { send, type CallContext } from "../send.js";
import type { Page } from "../types/common.js";
import type {
  CopySavedQueryRequest,
  CreateSavedQueryRequest,
  ListSavedQueriesOptions,
  ReplaceSharesResponse,
  SavedQuery,
  SavedQueryPaging,
  SavedQueryShares,
  SavedQueryUse,
  SharePrincipal,
  TransferSavedQueryRequest,
  TransferSavedQueryResponse,
  UpdateSavedQueryRequest,
} from "../types/savedQueries.js";

interface Subject {
  id: string;
  paging?: SavedQueryPaging;
}

export const savedQueriesCalls = (ctx: CallContext) => {
  const exports = exportMethods(ctx, ({ id, paging }: Subject) => ({
    op: "exportSavedQuery",
    params: { savedQueryId: id },
    body: paging,
  }));
  return {
    list: (options?: ListSavedQueriesOptions): Promise<Page<SavedQuery>> =>
      send(ctx, { op: "listSavedQueries", query: { ...options } }),
    get: (id: string): Promise<SavedQuery | null> =>
      send(ctx, {
        op: "getSavedQuery",
        params: { savedQueryId: id },
        nullOn404: true,
      }),
    create: (body: CreateSavedQueryRequest): Promise<SavedQuery> =>
      send(ctx, { op: "createSavedQuery", body, once: true }),
    update: (id: string, body: UpdateSavedQueryRequest): Promise<SavedQuery> =>
      send(ctx, {
        op: "updateSavedQuery",
        params: { savedQueryId: id },
        body,
        once: true,
      }),
    delete: async (id: string): Promise<void> => {
      await send(ctx, {
        op: "deleteSavedQuery",
        params: { savedQueryId: id },
        once: false,
      });
    },
    copy: (id: string, body: CopySavedQueryRequest): Promise<SavedQuery> =>
      send(ctx, {
        op: "copySavedQuery",
        params: { savedQueryId: id },
        body,
        once: true,
      }),
    /**
     * Runs it as stored, or with `paging` in place of its `limit` and
     * `offset`. A saved query the caller may not run is a `ZeteoError` with
     * code `saved_query_not_accessible` (403). Read-only, like `query.run`,
     * so it may be repeated after a 5xx.
     */
    run: (
      id: string,
      paging?: SavedQueryPaging,
      options?: { signal?: AbortSignal }
    ): Promise<QueryResult> =>
      send(ctx, {
        op: "runSavedQuery",
        params: { savedQueryId: id },
        body: paging,
        once: false,
        signal: options?.signal,
      }),
    /** The same streaming reads as `client.export`, of a saved query. */
    export: {
      rows: (
        id: string,
        paging?: SavedQueryPaging,
        options?: { signal?: AbortSignal }
      ): Promise<ExportRows> => exports.rows({ id, paging }, options),
      stream: (
        id: string,
        paging?: SavedQueryPaging,
        options?: { format?: "ndjson" | "csv"; signal?: AbortSignal }
      ): Promise<ExportStream> => exports.stream({ id, paging }, options),
    },
    /**
     * The dashboards and saved panels built on it (`zeteo.dashboards.read`).
     */
    dashboards: (id: string): Promise<{ data: SavedQueryUse[] }> =>
      send(ctx, {
        op: "listSavedQueryDashboards",
        params: { savedQueryId: id },
      }),
    listShares: (id: string): Promise<SavedQueryShares> =>
      send(ctx, { op: "listSavedQueryShares", params: { savedQueryId: id } }),
    // Never repeated: a second PUT would find the users already added and lose the warnings.
    replaceShares: (
      id: string,
      principals: SharePrincipal[]
    ): Promise<ReplaceSharesResponse> =>
      send(ctx, {
        op: "replaceSavedQueryShares",
        params: { savedQueryId: id },
        body: { principals },
        once: true,
      }),
    transfer: (
      id: string,
      body: TransferSavedQueryRequest
    ): Promise<TransferSavedQueryResponse> =>
      send(ctx, {
        op: "transferSavedQuery",
        params: { savedQueryId: id },
        body,
        once: true,
      }),
  };
};
