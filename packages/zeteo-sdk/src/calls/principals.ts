import { send, type CallContext } from "../send.js";
import type {
  Principal,
  PrincipalRef,
  SearchPrincipalsOptions,
} from "../types/principals.js";

export const principalsCalls = (ctx: CallContext) => ({
  search: (options: SearchPrincipalsOptions): Promise<{ data: Principal[] }> =>
    send(ctx, { op: "searchPrincipals", query: { ...options } }),
  // A POST that changes nothing: no `once`, so a 5xx is repeated like a GET's.
  lookup: (principals: PrincipalRef[]): Promise<{ data: Principal[] }> =>
    send(ctx, { op: "lookupPrincipals", body: { principals } }),
});
