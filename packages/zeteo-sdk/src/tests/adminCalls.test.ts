import { principalLimitsCalls } from "../calls/principalLimits.js";
import { OPERATIONS, type OperationId } from "../operations.js";
import { useStubbedClient } from "./support/callContext.js";
import { sourcesCalls } from "../calls/sources.js";
import { grantsCalls } from "../calls/grants.js";
import type { CallContext } from "../send.js";
import { describe, expect, it } from "vitest";

const ID = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";

interface Row {
  name: string;
  op: OperationId;
  params?: Record<string, string>;
  call: (ctx: CallContext) => Promise<unknown>;
  body?: unknown;
  query?: Record<string, string>;
  // 204 operations resolve void.
  noContent?: true;
}

const sourceBody = { name: "Sales", schemas: ["public"] };
const createSource = {
  slug: "sales",
  name: "Sales",
  type: "postgres" as const,
  settings: { host: "db", database: "d", user: "u", password: "p" },
  schemas: ["public"],
};
const relation = {
  name: "customer",
  from_table_id: ID,
  from_columns: ["customer_id"],
  to_table_id: ID2,
  to_columns: ["id"],
  to_many: false,
};
const grant = {
  principal_type: "user" as const,
  principal_id: ID,
  table_id: ID2,
  all_columns: false as const,
  column_ids: [ID],
};

const rows: Row[] = [
  {
    name: "sources.list",
    op: "listSources",
    call: (c) =>
      sourcesCalls(c).list({ limit: 5, cursor: "c", include_archived: true }),
    query: { limit: "5", cursor: "c", include_archived: "true" },
  },
  {
    name: "sources.get",
    op: "getSource",
    params: { sourceId: ID },
    call: (c) => sourcesCalls(c).get(ID),
  },
  {
    name: "sources.create",
    op: "createSource",
    call: (c) => sourcesCalls(c).create(createSource),
    body: createSource,
  },
  {
    name: "sources.update",
    op: "updateSource",
    params: { sourceId: ID },
    call: (c) => sourcesCalls(c).update(ID, sourceBody),
    body: sourceBody,
  },
  {
    name: "sources.archive",
    op: "archiveSource",
    params: { sourceId: ID },
    call: (c) => sourcesCalls(c).archive(ID),
    noContent: true,
  },
  {
    name: "sources.test",
    op: "testSource",
    params: { sourceId: ID },
    call: (c) => sourcesCalls(c).test(ID),
  },
  {
    name: "sources.refresh",
    op: "refreshSource",
    params: { sourceId: ID },
    call: (c) => sourcesCalls(c).refresh(ID),
  },
  {
    name: "sources.tables.list",
    op: "listTables",
    params: { sourceId: ID },
    call: (c) => sourcesCalls(c).tables.list(ID, { include_missing: true }),
    query: { include_missing: "true" },
  },
  {
    name: "sources.tables.get",
    op: "getTable",
    params: { sourceId: ID, tableId: ID2 },
    call: (c) => sourcesCalls(c).tables.get(ID, ID2),
  },
  {
    name: "sources.tables.update",
    op: "patchTable",
    params: { sourceId: ID, tableId: ID2 },
    call: (c) => sourcesCalls(c).tables.update(ID, ID2, { description: null }),
    body: { description: null },
  },
  {
    name: "sources.relations.list",
    op: "listRelations",
    params: { sourceId: ID },
    call: (c) => sourcesCalls(c).relations.list(ID, { limit: 2 }),
    query: { limit: "2" },
  },
  {
    name: "sources.relations.declare",
    op: "declareRelation",
    params: { sourceId: ID },
    call: (c) => sourcesCalls(c).relations.declare(ID, relation),
    body: relation,
  },
  {
    name: "sources.relations.delete",
    op: "deleteRelation",
    params: { sourceId: ID, relationId: ID2 },
    call: (c) => sourcesCalls(c).relations.delete(ID, ID2),
    noContent: true,
  },
  {
    name: "grants.list",
    op: "listGrants",
    call: (c) =>
      grantsCalls(c).list({
        principal_type: "group",
        principal_id: ID,
        table_id: ID2,
        source_id: ID,
        limit: 3,
      }),
    query: {
      principal_type: "group",
      principal_id: ID,
      table_id: ID2,
      source_id: ID,
      limit: "3",
    },
  },
  {
    name: "grants.get",
    op: "getGrant",
    params: { grantId: ID },
    call: (c) => grantsCalls(c).get(ID),
  },
  {
    name: "grants.create",
    op: "createGrant",
    call: (c) => grantsCalls(c).create(grant),
    body: grant,
  },
  {
    name: "grants.replace",
    op: "replaceGrant",
    params: { grantId: ID },
    call: (c) => grantsCalls(c).replace(ID, { all_columns: true }),
    body: { all_columns: true },
  },
  {
    name: "grants.delete",
    op: "deleteGrant",
    params: { grantId: ID },
    call: (c) => grantsCalls(c).delete(ID),
    noContent: true,
  },
  {
    name: "principalLimits.list",
    op: "listPrincipalLimits",
    call: (c) =>
      principalLimitsCalls(c).list({ principal_type: "user", cursor: "x" }),
    query: { principal_type: "user", cursor: "x" },
  },
  {
    name: "principalLimits.get",
    op: "getPrincipalLimit",
    params: { principalLimitId: ID },
    call: (c) => principalLimitsCalls(c).get(ID),
  },
  {
    name: "principalLimits.create",
    op: "createPrincipalLimit",
    call: (c) =>
      principalLimitsCalls(c).create({
        principal_type: "user",
        principal_id: ID,
        query_concurrency: 3,
      }),
    body: { principal_type: "user", principal_id: ID, query_concurrency: 3 },
  },
  {
    name: "principalLimits.update",
    op: "updatePrincipalLimit",
    params: { principalLimitId: ID },
    call: (c) =>
      principalLimitsCalls(c).update(ID, { export_concurrency: null }),
    body: { export_concurrency: null },
  },
  {
    name: "principalLimits.delete",
    op: "deletePrincipalLimit",
    params: { principalLimitId: ID },
    call: (c) => principalLimitsCalls(c).delete(ID),
    noContent: true,
  },
];

const expectedPath = (row: Row) =>
  OPERATIONS[row.op].path.replace(
    /\{(\w+)\}/g,
    (_, name: string) => row.params![name]
  );

describe("admin calls", () => {
  const t = useStubbedClient();

  it("covers 23 distinct operations", () => {
    expect(new Set(rows.map((r) => r.op)).size).toBe(23);
  });

  it.each(rows)("$name sends $op and returns the body", async (row) => {
    const stubbed = { id: "x", data: [], next_cursor: null };
    t.stub.respond(() => (row.noContent ? { status: 204 } : { body: stubbed }));
    const result = await row.call(t.ctx("p-1"));
    expect(result).toEqual(row.noContent ? undefined : stubbed);
    expect(t.stub.requests).toHaveLength(1);
    const request = t.stub.requests[0];
    expect(request.method).toBe(OPERATIONS[row.op].method);
    expect(request.path).toBe(expectedPath(row));
    expect(request.query).toEqual(row.query ?? {});
    expect(request.body).toEqual(row.body);
    expect(request.headers.authorization).toBe("Bearer p-1");
  });

  it.each([
    ["sources.get", (c: CallContext) => sourcesCalls(c).get(ID)],
    [
      "sources.tables.get",
      (c: CallContext) => sourcesCalls(c).tables.get(ID, ID2),
    ],
    ["grants.get", (c: CallContext) => grantsCalls(c).get(ID)],
    [
      "principalLimits.get",
      (c: CallContext) => principalLimitsCalls(c).get(ID),
    ],
  ])("%s resolves null on 404", async (_, call) => {
    t.stub.respond(() => ({ status: 404, body: { error: "not_found" } }));
    expect(await call(t.ctx("p-1"))).toBeNull();
  });

  it.each([
    [
      "sources.update",
      (c: CallContext) => sourcesCalls(c).update(ID, sourceBody),
    ],
    [
      "tables.update",
      (c: CallContext) =>
        sourcesCalls(c).tables.update(ID, ID2, { description: "d" }),
    ],
    [
      "grants.replace",
      (c: CallContext) => grantsCalls(c).replace(ID, { all_columns: true }),
    ],
    [
      "principalLimits.update",
      (c: CallContext) =>
        principalLimitsCalls(c).update(ID, { query_concurrency: 1 }),
    ],
  ])("%s throws on 404", async (_, call) => {
    t.stub.respond(() => ({ status: 404, body: { error: "not_found" } }));
    await expect(call(t.ctx("p-1"))).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
  });

  it("grants.create makes one request on a 500", async () => {
    t.stub.respond(() => ({ status: 500, body: { error: "boom" } }));
    await expect(grantsCalls(t.ctx("p-1")).create(grant)).rejects.toMatchObject(
      { status: 500 }
    );
    expect(t.stub.requests).toHaveLength(1);
  });

  it("grants.replace is repeated after a 500", async () => {
    let n = 0;
    t.stub.respond(() =>
      ++n === 1
        ? { status: 500, body: { error: "boom" } }
        : { body: { id: ID } }
    );
    expect(
      await grantsCalls(t.ctx("p-1")).replace(ID, { all_columns: true })
    ).toEqual({ id: ID });
    expect(t.stub.requests).toHaveLength(2);
  });

  const bad = "a/b";
  it.each([
    ["sources.get", (c: CallContext) => sourcesCalls(c).get(bad)],
    [
      "sources.update",
      (c: CallContext) => sourcesCalls(c).update(bad, sourceBody),
    ],
    ["sources.archive", (c: CallContext) => sourcesCalls(c).archive(bad)],
    ["sources.test", (c: CallContext) => sourcesCalls(c).test(bad)],
    ["sources.refresh", (c: CallContext) => sourcesCalls(c).refresh(bad)],
    ["tables.list", (c: CallContext) => sourcesCalls(c).tables.list(bad)],
    [
      "tables.get source",
      (c: CallContext) => sourcesCalls(c).tables.get(bad, ID),
    ],
    [
      "tables.get table",
      (c: CallContext) => sourcesCalls(c).tables.get(ID, bad),
    ],
    [
      "tables.update table",
      (c: CallContext) =>
        sourcesCalls(c).tables.update(ID, bad, { description: null }),
    ],
    ["relations.list", (c: CallContext) => sourcesCalls(c).relations.list(bad)],
    [
      "relations.declare",
      (c: CallContext) => sourcesCalls(c).relations.declare(bad, relation),
    ],
    [
      "relations.delete source",
      (c: CallContext) => sourcesCalls(c).relations.delete(bad, ID),
    ],
    [
      "relations.delete relation",
      (c: CallContext) => sourcesCalls(c).relations.delete(ID, bad),
    ],
    ["grants.get", (c: CallContext) => grantsCalls(c).get(bad)],
    [
      "grants.replace",
      (c: CallContext) => grantsCalls(c).replace(bad, { all_columns: true }),
    ],
    ["grants.delete", (c: CallContext) => grantsCalls(c).delete(bad)],
    [
      "principalLimits.get",
      (c: CallContext) => principalLimitsCalls(c).get(bad),
    ],
    [
      "principalLimits.update",
      (c: CallContext) => principalLimitsCalls(c).update(bad, {}),
    ],
    [
      "principalLimits.delete",
      (c: CallContext) => principalLimitsCalls(c).delete(bad),
    ],
  ])(
    "%s rejects an id of a/b with invalid_id and no request",
    async (_, call) => {
      t.stub.respond(() => ({ body: {} }));
      await expect(call(t.ctx("p-1"))).rejects.toMatchObject({
        code: "invalid_id",
      });
      expect(t.stub.requests).toHaveLength(0);
    }
  );
});
