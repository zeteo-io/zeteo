import { send, type CallContext } from "../send.js";
import type { Me } from "../types/principals.js";

export const meCalls = (ctx: CallContext) => ({
  get: (): Promise<Me> => send(ctx, { op: "getMe" }),
});
