import type { ListRunsOptions, QueryRun } from "../types/runs.js";
import { send, type CallContext } from "../send.js";
import type { Page } from "../types/common.js";

export const runsCalls = (ctx: CallContext) => ({
  list: (options?: ListRunsOptions): Promise<Page<QueryRun>> =>
    send(ctx, { op: "listRuns", query: { ...options } }),
});
