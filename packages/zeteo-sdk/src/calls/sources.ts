import type { ListOptions, Page } from "../types/common.js";
import { send, type CallContext } from "../send.js";
import type {
  AddTablesRequest,
  CreateUploadSourceRequest,
  ReuploadTableRequest,
  TransferSourceRequest,
  UpdateUploadColumnRequest,
} from "../types/uploads.js";
import type {
  CreateSourceRequest,
  DeclareRelationRequest,
  RenameRelationRequest,
  ListSourcesOptions,
  ListTablesOptions,
  MergedColumnsResponse,
  MergedTableRequest,
  PatchTableRequest,
  RefreshSummary,
  SyncSummary,
  Relation,
  Source,
  Table,
  TableDetail,
  TestSourceResponse,
  UpdateSourceRequest,
} from "../types/sources.js";

export const sourcesCalls = (ctx: CallContext) => ({
  list: (options?: ListSourcesOptions): Promise<Page<Source>> =>
    send(ctx, { op: "listSources", query: { ...options } }),
  get: (sourceId: string): Promise<Source | null> =>
    send(ctx, { op: "getSource", params: { sourceId }, nullOn404: true }),
  /** A database, or (`type: "upload"`) a source from the caller's staging of a file or a spreadsheet. */
  create: (
    body: CreateSourceRequest | CreateUploadSourceRequest
  ): Promise<Source> => send(ctx, { op: "createSource", body, once: true }),
  update: (sourceId: string, body: UpdateSourceRequest): Promise<Source> =>
    send(ctx, {
      op: "updateSource",
      params: { sourceId },
      body,
      once: true,
    }),
  // The API answers 204.
  archive: async (sourceId: string): Promise<void> => {
    await send(ctx, {
      op: "archiveSource",
      params: { sourceId },
      once: true,
    });
  },
  /** An upload source only: deletes its data. The API answers 204. */
  delete: async (sourceId: string): Promise<void> => {
    await send(ctx, { op: "deleteSource", params: { sourceId }, once: true });
  },
  /** An upload source only: hands it to another user. */
  transfer: (sourceId: string, body: TransferSourceRequest): Promise<Source> =>
    send(ctx, {
      op: "transferSource",
      params: { sourceId },
      body,
      once: true,
    }),
  /** An upload source only: adds tables from the caller's staging. */
  addTables: (sourceId: string, body: AddTablesRequest): Promise<Source> =>
    send(ctx, {
      op: "addTables",
      params: { sourceId },
      body,
      once: true,
    }),
  /** An upload source only: loads a table again from the caller's staging. */
  reuploadTable: (
    sourceId: string,
    tableId: string,
    body: ReuploadTableRequest
  ): Promise<Source> =>
    send(ctx, {
      op: "reuploadTable",
      params: { sourceId, tableId },
      body,
      once: true,
    }),
  /** An upload source only: removes a table. The API answers 204. */
  removeTable: async (sourceId: string, tableId: string): Promise<void> => {
    await send(ctx, {
      op: "deleteTable",
      params: { sourceId, tableId },
      once: true,
    });
  },
  /** An upload source only: merges two or more of its tables as one view. */
  createMergedTable: (
    sourceId: string,
    body: MergedTableRequest
  ): Promise<Table> =>
    send(ctx, {
      op: "createMergedTable",
      params: { sourceId },
      body,
      once: true,
    }),
  /** A merged table only: replaces its definition. */
  updateMergedTable: (
    sourceId: string,
    tableId: string,
    body: MergedTableRequest
  ): Promise<Table> =>
    send(ctx, {
      op: "putMergedTable",
      params: { sourceId, tableId },
      body,
      once: true,
    }),
  /** An upload source only: the union of the given tables' columns and a suggested label for each, for merging them. */
  mergedColumns: (
    sourceId: string,
    memberTableIds: string[]
  ): Promise<MergedColumnsResponse> =>
    send(ctx, {
      op: "getMergedColumns",
      params: { sourceId },
      query: { member: memberTableIds },
    }),
  /** An upload source only: retypes, renames or describes a column. */
  updateColumn: (
    sourceId: string,
    tableId: string,
    columnId: string,
    body: UpdateUploadColumnRequest
  ): Promise<Source> =>
    send(ctx, {
      op: "updateColumn",
      params: { sourceId, tableId, columnId },
      body,
      once: true,
    }),
  test: (sourceId: string): Promise<TestSourceResponse> =>
    send(ctx, { op: "testSource", params: { sourceId }, once: true }),
  /** An upload source is synced instead (Sync now) and answers a `SyncSummary`; `409 nothing_to_sync` without Google Sheets tables. */
  refresh: (sourceId: string): Promise<RefreshSummary | SyncSummary> =>
    send(ctx, { op: "refreshSource", params: { sourceId }, once: true }),
  tables: {
    list: (
      sourceId: string,
      options?: ListTablesOptions
    ): Promise<Page<Table>> =>
      send(ctx, {
        op: "listTables",
        params: { sourceId },
        query: { ...options },
      }),
    get: (sourceId: string, tableId: string): Promise<TableDetail | null> =>
      send(ctx, {
        op: "getTable",
        params: { sourceId, tableId },
        nullOn404: true,
      }),
    update: (
      sourceId: string,
      tableId: string,
      body: PatchTableRequest
    ): Promise<TableDetail> =>
      send(ctx, {
        op: "patchTable",
        params: { sourceId, tableId },
        body,
        once: true,
      }),
  },
  relations: {
    list: (sourceId: string, options?: ListOptions): Promise<Page<Relation>> =>
      send(ctx, {
        op: "listRelations",
        params: { sourceId },
        query: { ...options },
      }),
    declare: (
      sourceId: string,
      body: DeclareRelationRequest
    ): Promise<Relation> =>
      send(ctx, {
        op: "declareRelation",
        params: { sourceId },
        body,
        once: true,
      }),
    update: (
      sourceId: string,
      relationId: string,
      body: RenameRelationRequest
    ): Promise<Relation> =>
      send(ctx, {
        op: "updateRelation",
        params: { sourceId, relationId },
        body,
        once: true,
      }),
    delete: async (sourceId: string, relationId: string): Promise<void> => {
      await send(ctx, {
        op: "deleteRelation",
        params: { sourceId, relationId },
        once: false,
      });
    },
  },
});
