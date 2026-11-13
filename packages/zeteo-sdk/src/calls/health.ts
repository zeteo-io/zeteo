import type { HealthStatus } from "../types/common.js";
import { send, type CallContext } from "../send.js";

export const healthCalls = (ctx: CallContext) => ({
  get: (): Promise<HealthStatus> =>
    send({ ...ctx, token: undefined }, { op: "getHealth" }),
});
