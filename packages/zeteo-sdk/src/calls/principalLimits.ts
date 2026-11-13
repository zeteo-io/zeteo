import { send, type CallContext } from "../send.js";
import type { Page } from "../types/common.js";
import type {
  CreatePrincipalLimitRequest,
  ListPrincipalLimitsOptions,
  PrincipalLimit,
  UpdatePrincipalLimitRequest,
} from "../types/principalLimits.js";

export const principalLimitsCalls = (ctx: CallContext) => ({
  list: (options?: ListPrincipalLimitsOptions): Promise<Page<PrincipalLimit>> =>
    send(ctx, { op: "listPrincipalLimits", query: { ...options } }),
  get: (id: string): Promise<PrincipalLimit | null> =>
    send(ctx, {
      op: "getPrincipalLimit",
      params: { principalLimitId: id },
      nullOn404: true,
    }),
  create: (body: CreatePrincipalLimitRequest): Promise<PrincipalLimit> =>
    send(ctx, { op: "createPrincipalLimit", body, once: true }),
  update: (
    id: string,
    body: UpdatePrincipalLimitRequest
  ): Promise<PrincipalLimit> =>
    send(ctx, {
      op: "updatePrincipalLimit",
      params: { principalLimitId: id },
      body,
      once: true,
    }),
  delete: async (id: string): Promise<void> => {
    await send(ctx, {
      op: "deletePrincipalLimit",
      params: { principalLimitId: id },
      once: false,
    });
  },
});
