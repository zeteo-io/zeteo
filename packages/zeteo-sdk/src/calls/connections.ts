import { send, type CallContext } from "../send.js";
import type {
  GoogleConnection,
  PutGoogleConnectionRequest,
} from "../types/uploads.js";

export const connectionsCalls = (ctx: CallContext) => ({
  google: {
    /** Who Zeteo signs in to Google as. */
    get: (): Promise<GoogleConnection> =>
      send(ctx, { op: "getGoogleConnection" }),
    /** Replaces the service-account key. */
    put: (body: PutGoogleConnectionRequest): Promise<GoogleConnection> =>
      send(ctx, { op: "putGoogleConnection", body, once: true }),
  },
});
