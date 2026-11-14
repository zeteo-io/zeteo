import { fromResponse, sendRaw, type CallContext } from "../send.js";
import type { HealthStatus } from "../types/common.js";
import { ZeteoError } from "../errors.js";

const isHealth = (body: unknown): body is HealthStatus =>
  typeof body === "object" &&
  body !== null &&
  typeof (body as { status?: unknown }).status === "string";

// /health is public: no Authorization, no service token, never retried.
export const healthCalls = (ctx: CallContext) => ({
  get: async (): Promise<HealthStatus> => {
    const response = await sendRaw(ctx, {
      op: "getHealth",
      anonymous: true,
      once: true,
      acceptStatus: [503],
    });
    if (isHealth(response.data)) return response.data;
    const error = fromResponse(response);
    if (response.status === 503) throw error;
    throw new ZeteoError("@zeteo-io/sdk: the health response had no status", {
      status: response.status,
      code: "invalid_response",
      requestId: error.requestId,
    });
  },
});
