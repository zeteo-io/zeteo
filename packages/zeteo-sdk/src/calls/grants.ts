import { send, type CallContext } from "../send.js";
import type { Page } from "../types/common.js";
import type {
  CreateGrantRequest,
  Grant,
  ListGrantsOptions,
  ReplaceGrantRequest,
} from "../types/grants.js";

export const grantsCalls = (ctx: CallContext) => ({
  list: (options?: ListGrantsOptions): Promise<Page<Grant>> =>
    send(ctx, { op: "listGrants", query: { ...options } }),
  get: (grantId: string): Promise<Grant | null> =>
    send(ctx, { op: "getGrant", params: { grantId }, nullOn404: true }),
  create: (body: CreateGrantRequest): Promise<Grant> =>
    send(ctx, { op: "createGrant", body, once: true }),
  // A PUT that replaces whole, so repeating it after a 5xx is harmless.
  replace: (grantId: string, body: ReplaceGrantRequest): Promise<Grant> =>
    send(ctx, { op: "replaceGrant", params: { grantId }, body, once: false }),
  delete: async (grantId: string): Promise<void> => {
    await send(ctx, { op: "deleteGrant", params: { grantId }, once: false });
  },
});
