import type { Catalog, GetCatalogOptions } from "../types/catalog.js";
import { send, type CallContext } from "../send.js";

export const catalogCalls = (ctx: CallContext) => ({
  get: (options?: GetCatalogOptions): Promise<Catalog> =>
    send(ctx, { op: "getCatalog", query: { source: options?.source } }),
});
