import type { ListMyRunsOptions, QueryRun } from "../types/runs.js";
import { send, type CallContext } from "../send.js";
import type { Me } from "../types/principals.js";
import type { Page } from "../types/common.js";
import type {
  Principal,
  SearchPrincipalsOptions,
} from "../types/principals.js";

export const meCalls = (ctx: CallContext) => ({
  get: (): Promise<Me> => send(ctx, { op: "getMe" }),
  /** The caller's own runs, whoever's token the call carries. */
  runs: (options?: ListMyRunsOptions): Promise<Page<QueryRun>> =>
    send(ctx, { op: "listMyRuns", query: { ...options } }),
  /** Users and groups the caller may share a saved query with. */
  principals: (
    options: SearchPrincipalsOptions
  ): Promise<{ data: Principal[] }> =>
    send(ctx, { op: "searchMyPrincipals", query: { ...options } }),
});
