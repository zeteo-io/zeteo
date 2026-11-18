import { send, type CallContext } from "../send.js";
import type {
  AddTablesRequest,
  CreateFileSourceRequest,
  FileSource,
  ListFileSourcesOptions,
  ReuploadTableRequest,
  TransferFileSourceRequest,
  UpdateFileColumnRequest,
  UploadResponse,
} from "../types/fileSources.js";

export const fileSourcesCalls = (ctx: CallContext) => ({
  /** Stages one CSV or xlsx file (multipart field `file`) and returns its preview. */
  upload: (file: Blob, filename: string): Promise<UploadResponse> => {
    const body = new FormData();
    body.append("file", file, filename);
    return send(ctx, { op: "uploadFile", body, once: true });
  },
  list: (options?: ListFileSourcesOptions): Promise<{ data: FileSource[] }> =>
    send(ctx, { op: "listFileSources", query: { ...options } }),
  create: (body: CreateFileSourceRequest): Promise<FileSource> =>
    send(ctx, { op: "createFileSource", body, once: true }),
  get: (sourceId: string): Promise<FileSource | null> =>
    send(ctx, { op: "getFileSource", params: { sourceId }, nullOn404: true }),
  rename: (sourceId: string, name: string): Promise<FileSource> =>
    send(ctx, {
      op: "updateFileSource",
      params: { sourceId },
      body: { name },
      once: true,
    }),
  // The API answers 204.
  delete: async (sourceId: string): Promise<void> => {
    await send(ctx, {
      op: "deleteFileSource",
      params: { sourceId },
      once: true,
    });
  },
  transfer: (
    sourceId: string,
    body: TransferFileSourceRequest
  ): Promise<FileSource> =>
    send(ctx, {
      op: "transferFileSource",
      params: { sourceId },
      body,
      once: true,
    }),
  tables: {
    add: (sourceId: string, body: AddTablesRequest): Promise<FileSource> =>
      send(ctx, {
        op: "addFileSourceTables",
        params: { sourceId },
        body,
        once: true,
      }),
    reupload: (
      sourceId: string,
      tableId: string,
      body: ReuploadTableRequest
    ): Promise<FileSource> =>
      send(ctx, {
        op: "reuploadFileSourceTable",
        params: { sourceId, tableId },
        body,
        once: true,
      }),
    // The API answers 204.
    delete: async (sourceId: string, tableId: string): Promise<void> => {
      await send(ctx, {
        op: "deleteFileSourceTable",
        params: { sourceId, tableId },
        once: true,
      });
    },
    columns: {
      update: (
        sourceId: string,
        tableId: string,
        columnId: string,
        body: UpdateFileColumnRequest
      ): Promise<FileSource> =>
        send(ctx, {
          op: "updateFileSourceColumn",
          params: { sourceId, tableId, columnId },
          body,
          once: true,
        }),
    },
  },
});
