import { send, type CallContext } from "../send.js";
import type {
  LinkRequest,
  SheetsUploadResponse,
  UploadResponse,
} from "../types/uploads.js";

export const uploadsCalls = (ctx: CallContext) => ({
  /** Stages one CSV or xlsx file (multipart field `file`) and returns its preview. */
  create: (file: Blob, filename: string): Promise<UploadResponse> => {
    const body = new FormData();
    body.append("file", file, filename);
    return send(ctx, { op: "createUpload", body, once: true });
  },
  /** Stages every tab of a Google spreadsheet, by its link or id; with `source_id`, for tables to add to that upload source. */
  fromLink: (body: LinkRequest): Promise<SheetsUploadResponse> =>
    send(ctx, { op: "createUploadFromLink", body, once: true }),
  /** Discards the caller's own staging. The API answers 204. */
  discard: async (uploadId: string): Promise<void> => {
    await send(ctx, { op: "deleteUpload", params: { uploadId }, once: true });
  },
});
