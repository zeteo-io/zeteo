import type { ListOptions, Page } from "../types/common.js";
import { send, type CallContext } from "../send.js";
import type {
  CreateSourceRequest,
  DeclareRelationRequest,
  ListSourcesOptions,
  ListTablesOptions,
  PatchTableRequest,
  RefreshSummary,
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
  create: (body: CreateSourceRequest): Promise<Source> =>
    send(ctx, { op: "createSource", body, once: true }),
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
  test: (sourceId: string): Promise<TestSourceResponse> =>
    send(ctx, { op: "testSource", params: { sourceId }, once: true }),
  refresh: (sourceId: string): Promise<RefreshSummary> =>
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
    delete: async (sourceId: string, relationId: string): Promise<void> => {
      await send(ctx, {
        op: "deleteRelation",
        params: { sourceId, relationId },
        once: false,
      });
    },
  },
});
