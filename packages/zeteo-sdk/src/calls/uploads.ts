import type { UploadResponse } from "../types/uploads.js";
import { send, type CallContext } from "../send.js";

export const uploadsCalls = (ctx: CallContext) => ({
  /** Stages one CSV or xlsx file (multipart field `file`) and returns its preview. */
  create: (file: Blob, filename: string): Promise<UploadResponse> => {
    const body = new FormData();
    body.append("file", file, filename);
    return send(ctx, { op: "createUpload", body, once: true });
  },
  /** Discards the caller's own staging. The API answers 204. */
  discard: async (uploadId: string): Promise<void> => {
    await send(ctx, { op: "deleteUpload", params: { uploadId }, once: true });
  },
});
