import type { QueryResult } from "../types/query.js";
import { send, type CallContext } from "../send.js";
import type { Page } from "../types/common.js";
import type {
  CopySavedPanelRequest,
  CreateSavedPanelRequest,
  ListSavedPanelsOptions,
  PreviewSavedPanelRequest,
  SavedPanel,
  UpdateSavedPanelRequest,
} from "../types/savedPanels.js";
import type {
  DashboardShares,
  SharePrincipal,
  TransferOwnerRequest,
} from "../types/dashboards.js";

export const savedPanelsCalls = (ctx: CallContext) => ({
  list: (options?: ListSavedPanelsOptions): Promise<Page<SavedPanel>> =>
    send(ctx, { op: "listSavedPanels", query: { ...options } }),
  create: (body: CreateSavedPanelRequest): Promise<SavedPanel> =>
    send(ctx, { op: "createSavedPanel", body, once: true }),
  get: (id: string): Promise<SavedPanel | null> =>
    send(ctx, {
      op: "getSavedPanel",
      params: { savedPanelId: id },
      nullOn404: true,
    }),
  update: (id: string, body: UpdateSavedPanelRequest): Promise<SavedPanel> =>
    send(ctx, {
      op: "updateSavedPanel",
      params: { savedPanelId: id },
      body,
      once: true,
    }),
  delete: async (id: string): Promise<void> => {
    await send(ctx, {
      op: "deleteSavedPanel",
      params: { savedPanelId: id },
      once: false,
    });
  },
  copy: (id: string, body: CopySavedPanelRequest): Promise<SavedPanel> =>
    send(ctx, {
      op: "copySavedPanel",
      params: { savedPanelId: id },
      body,
      once: true,
    }),
  listShares: (id: string): Promise<DashboardShares> =>
    send(ctx, { op: "listSavedPanelShares", params: { savedPanelId: id } }),
  // Never repeated: a second PUT would find the shares already made.
  replaceShares: (
    id: string,
    principals: SharePrincipal[]
  ): Promise<DashboardShares> =>
    send(ctx, {
      op: "replaceSavedPanelShares",
      params: { savedPanelId: id },
      body: { principals },
      once: true,
    }),
  transfer: (id: string, body: TransferOwnerRequest): Promise<SavedPanel> =>
    send(ctx, {
      op: "transferSavedPanel",
      params: { savedPanelId: id },
      body,
      once: true,
    }),
  /**
   * Runs the saved panel's saved query as the caller, with `time_range`
   * applied to its time column, at most 5000 rows. A panel the caller may not
   * run is a `ZeteoError` with code `saved_query_not_accessible` (403).
   * Read-only, so it may be repeated after a 5xx.
   */
  preview: (
    id: string,
    body?: PreviewSavedPanelRequest,
    options?: { signal?: AbortSignal }
  ): Promise<QueryResult> =>
    send(ctx, {
      op: "previewSavedPanel",
      params: { savedPanelId: id },
      body,
      once: false,
      signal: options?.signal,
    }),
});
