import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createUser, roleId } from "../support/tereo.js";
import { PAID_ORDER_IDS, PAID_ORDERS } from "../support/zeteo.js";
import RequestHandler, { memoryBackend } from "@dianemo/core";
import { serviceToken, signIn } from "../support/oauth.js";
import { CLIENTS, stack } from "../support/stack.js";
import { expectJson } from "../support/http.js";
import { randomBytes } from "node:crypto";
import {
  createZeteoClient,
  paginate,
  QueryRefusedError,
  ZeteoError,
  type Grant,
  type Query,
} from "@zeteo-io/sdk";

const e2e = inject("e2e");

// PAID_ORDERS as the SDK's Query type, which wants `orderBy`'s direction as a literal.
const paidOrders = (): Query => ({
  source: e2e.source.slug,
  ...PAID_ORDERS,
  orderBy: [{ id: "asc" }],
});
const ids = (rows: unknown[][]) => rows.map((row) => row[0]);

const handler = new RequestHandler({
  key: randomBytes(32).toString("hex"),
  backend: memoryBackend(),
});
const zeteo = createZeteoClient({
  url: stack.zeteoUrl,
  tereoUrl: stack.tereoUrl,
  ...stack.app,
  handler,
});

/** The e2e-app service account's user, as Tereo reports it to the service itself. */
let serviceUserId: string;
/** A person with zeteo_user and no grant: dave is granted orders in the global setup. */
let erin: { id: string; token: string };
const grantsToRemove: string[] = [];

const grantOrdersToService = () =>
  zeteo.grants.create({
    principal_type: "user",
    principal_id: serviceUserId,
    table_id: e2e.source.tables.orders,
    all_columns: true,
  });

beforeAll(async () => {
  await zeteo.start();
  const token = await serviceToken(stack.app.clientId, stack.app.clientSecret);
  const me = await expectJson(200, "GET", `${stack.tereoUrl}/v1/account/me`, {
    token,
  });
  serviceUserId = (me.id ?? me.user?.id) as string;
  expect(serviceUserId).toEqual(expect.any(String));

  const email = "erin@e2e.example.com";
  const id = await createUser(e2e.admin.coreToken, email, [
    await roleId(e2e.admin.coreToken, "zeteo_user"),
  ]);
  erin = {
    id,
    token: await signIn({
      client: CLIENTS.web,
      email,
      clientSecret: stack.webClientSecret,
    }),
  };
});

afterAll(async () => {
  const failures: unknown[] = [];
  for (const id of grantsToRemove) {
    await zeteo.grants.delete(id).catch((err: unknown) => failures.push(err));
  }
  try {
    await zeteo.stop();
  } finally {
    await handler.stop();
  }
  if (failures.length > 0) throw failures[0];
});

describe("@zeteo-io/sdk against a real zeteo and Tereo", () => {
  it("as the service, before any grant, a query is refused", async () => {
    const refused = await zeteo.query
      .run({ source: e2e.source.slug, from: "orders", select: ["id"] })
      .catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(QueryRefusedError);
    expect(refused).toMatchObject({
      status: 422,
      code: "not_found_or_not_accessible",
    });
  });

  it("as the service with zeteo_admin, grants itself orders, queries, and removes the grant", async () => {
    const grant = await grantOrdersToService();
    // Removed in afterAll should an assertion fail before this test removes it.
    grantsToRemove.push(grant.id);
    expect(grant).toMatchObject({
      principal_type: "user",
      principal_id: serviceUserId,
      principal_status: "active",
      table: { id: e2e.source.tables.orders, name: "orders" },
    });
    expect((await zeteo.grants.get(grant.id))?.id).toBe(grant.id);

    const result = await zeteo.query.run(paidOrders());
    expect(ids(result.rows)).toEqual(PAID_ORDER_IDS);

    await zeteo.grants.delete(grant.id);
    grantsToRemove.splice(grantsToRemove.indexOf(grant.id), 1);
    expect(await zeteo.grants.get(grant.id)).toBeNull();
  });

  it("with a person's token, queries as that person, and the run log tells them apart", async () => {
    const asAlice = await zeteo
      .withToken(e2e.alice.token)
      .query.run(paidOrders());
    expect(ids(asAlice.rows)).toEqual(PAID_ORDER_IDS);

    const asErin = await zeteo
      .withToken(erin.token)
      .query.run(paidOrders())
      .catch((err: unknown) => err);
    expect(asErin).toBeInstanceOf(QueryRefusedError);
    expect(asErin).toMatchObject({ code: "not_found_or_not_accessible" });

    const aliceRuns = await zeteo.runs.list({ user_id: e2e.alice.id });
    const erinRuns = await zeteo.runs.list({ user_id: erin.id });
    expect(aliceRuns.data.map((run) => run.outcome)).toContain("ok");
    expect(erinRuns.data.map((run) => run.outcome)).toEqual(["refused"]);
    expect(new Set(aliceRuns.data.map((run) => run.user_id))).toEqual(
      new Set([e2e.alice.id])
    );
    expect(erinRuns.data.map((run) => run.user_id)).toEqual([erin.id]);
  });

  it("exports as the service: rows read to the end match the end line, and CSV starts with a header", async () => {
    const grant: Grant = await grantOrdersToService();
    grantsToRemove.push(grant.id);
    const exportQuery = {
      source: e2e.source.slug,
      from: "orders",
      select: ["id"],
      orderBy: [{ id: "asc" as const }],
    };

    const out = await zeteo.export.rows(exportQuery);
    expect(out.runId).toEqual(expect.any(String));
    expect(out.columns.map((c) => c.name)).toEqual(["id"]);
    const rows: unknown[][] = [];
    for await (const row of out.rows) rows.push(row);
    expect(ids(rows)).toEqual([1, 2, 3, 4, 5]);
    expect(await out.done).toEqual({ status: "complete", rows: rows.length });

    const csv = await zeteo.export.stream(exportQuery, { format: "csv" });
    expect(csv.runId).toEqual(expect.any(String));
    let text = "";
    for await (const chunk of csv.stream) text += String(chunk);
    expect(text.split(/\r?\n/)[0]).toBe("id");
  });

  it("paginates the source's tables one at a time and finds every table", async () => {
    const tables: string[] = [];
    for await (const table of paginate(
      zeteo.sources.tables.list.bind(null, e2e.source.id),
      { limit: 1 }
    )) {
      tables.push(table.name);
    }
    expect(tables.sort()).toEqual(Object.keys(e2e.source.tables).sort());
  });

  it("a person's token that is not for zeteo is refused with 401", async () => {
    const otherToken = await signIn({
      client: CLIENTS.other,
      email: e2e.alice.email,
    });
    const refused = await zeteo
      .withToken(otherToken)
      .query.run(paidOrders())
      .catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(ZeteoError);
    expect(refused).toMatchObject({ status: 401 });
  });

  it("reads who it is and searches the directory", async () => {
    const me = await zeteo.me.get();
    expect(me.id).toBe(serviceUserId);
    expect(me.type).toBe("service");
    expect(me.permissions).toContain("zeteo.grants.read");

    const found = await zeteo.principals.search({
      type: "user",
      q: "ice@e2e.ex",
    });
    expect(found.data).toContainEqual({
      type: "user",
      id: e2e.alice.id,
      name: "alice",
      email: e2e.alice.email,
      status: "active",
    });

    const looked = await zeteo.principals.lookup([
      { type: "group", id: e2e.groupId },
    ]);
    expect(looked.data).toEqual([
      {
        type: "group",
        id: e2e.groupId,
        name: "e2e-analysts",
        status: "active",
      },
    ]);
  });
});
