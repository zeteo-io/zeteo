import type { Query, QueryResult } from "../types/query.js";
import { send, type CallContext } from "../send.js";

export const queryCalls = (ctx: CallContext) => ({
  // Read-only, so it may be repeated after a 5xx.
  run: (
    query: Query,
    options?: { signal?: AbortSignal }
  ): Promise<QueryResult> =>
    send(ctx, {
      op: "runQuery",
      body: query,
      once: false,
      signal: options?.signal,
    }),
});
