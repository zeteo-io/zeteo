import type { HealthStatus } from "../types/common.js";
import { send, type CallContext } from "../send.js";
import { ZeteoError } from "../errors.js";

const isHealth = (body: unknown): body is HealthStatus =>
  typeof body === "object" &&
  body !== null &&
  typeof (body as { status?: unknown }).status === "string";

// /health is public: no Authorization, no service token, never retried.
export const healthCalls = (ctx: CallContext) => ({
  get: async (): Promise<HealthStatus> => {
    const body = await send<unknown>(ctx, {
      op: "getHealth",
      anonymous: true,
      once: true,
      acceptStatus: [503],
    });
    if (!isHealth(body)) {
      throw new ZeteoError("unhealthy", { status: 503, code: "http_503" });
    }
    return body;
  },
});
