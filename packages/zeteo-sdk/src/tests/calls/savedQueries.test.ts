import type { SavedQuery } from "../../types/savedQueries.js";
import { useStubbedClient } from "../support/callContext.js";
import type { Query } from "../../types/query.js";
import { describe, expect, it } from "vitest";
import { ZeteoError } from "../../errors.js";

const ID = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const RUN = "0193f1c2-7a4e-7c3d-9b1a-2f6e8d0c4b5a";
const query: Query = { source: "sales-db", from: "orders", select: ["id"] };

const saved: SavedQuery = {
  id: ID,
  name: "Orders",
  description: "",
  owner: { id: USER, name: "Ada" },
  accessible: true,
  available_for_dashboards: false,
  created_at: "2026-11-17T10:00:00.000Z",
  updated_at: "2026-11-17T10:00:00.000Z",
  last_run_at: null,
  you_last_ran_at: null,
  source: { id: ID, slug: "sales-db" },
  query,
};

const readAll = async (rows: AsyncIterable<unknown[]>) => {
  const out: unknown[][] = [];
  for await (const row of rows) out.push(row);
  return out;
};

describe("savedQueries", () => {
  const t = useStubbedClient();

  it("list sends GET /v1/saved-queries with its filters", async () => {
    t.stub.respond(() => ({ body: { data: [saved], next_cursor: null } }));
    const page = await t.client.savedQueries.list({
      scope: "all",
      q: "ord",
      source_id: ID,
      owner_id: USER,
      shared_with_type: "group",
      shared_with_id: ID,
      limit: 5,
      cursor: "c",
    });
    expect(page.data).toEqual([saved]);
    expect(t.stub.requests[0]).toMatchObject({
      method: "GET",
      path: "/v1/saved-queries",
      query: {
        scope: "all",
        q: "ord",
        source_id: ID,
        owner_id: USER,
        shared_with_type: "group",
        shared_with_id: ID,
        limit: "5",
        cursor: "c",
      },
    });
  });

  it("list without options sends no query", async () => {
    t.stub.respond(() => ({ body: { data: [], next_cursor: null } }));
    await t.client.savedQueries.list();
    expect(t.stub.requests[0].query).toEqual({});
  });

  it("create sends POST with the body as given", async () => {
    t.stub.respond(() => ({ status: 201, body: saved }));
    const body = { name: "Orders", description: "d", query };
    expect(await t.client.savedQueries.create(body)).toEqual(saved);
    expect(t.stub.requests[0]).toMatchObject({
      method: "POST",
      path: "/v1/saved-queries",
      body,
    });
  });

  it("list takes the available scope", async () => {
    t.stub.respond(() => ({ body: { data: [], next_cursor: null } }));
    await t.client.savedQueries.list({ scope: "available" });
    expect(t.stub.requests[0].query).toEqual({ scope: "available" });
  });

  it("update can offer it to dashboards", async () => {
    t.stub.respond(() => ({
      body: { ...saved, available_for_dashboards: true },
    }));
    const out = await t.client.savedQueries.update(ID, {
      available_for_dashboards: true,
    });
    expect(out.available_for_dashboards).toBe(true);
    expect(t.stub.requests[0]).toMatchObject({
      method: "PATCH",
      path: `/v1/saved-queries/${ID}`,
      body: { available_for_dashboards: true },
    });
  });

  it("dashboards sends GET .../dashboards", async () => {
    const data = [
      {
        type: "dashboard",
        id: ID,
        name: "Sales",
        owner: { id: USER, name: "Ada" },
      },
    ];
    t.stub.respond(() => ({ body: { data } }));
    expect(await t.client.savedQueries.dashboards(ID)).toEqual({ data });
    expect(t.stub.requests[0]).toMatchObject({
      method: "GET",
      path: `/v1/saved-queries/${ID}/dashboards`,
    });
  });

  it("get sends GET by id and returns null on a 404", async () => {
    t.stub.respond(() => ({ body: saved }));
    expect(await t.client.savedQueries.get(ID)).toEqual(saved);
    expect(t.stub.requests[0]).toMatchObject({
      method: "GET",
      path: `/v1/saved-queries/${ID}`,
    });
    t.stub.respond(() => ({ status: 404, body: { error: "not_found" } }));
    expect(await t.client.savedQueries.get(ID)).toBeNull();
  });

  it("update sends PATCH with the changes", async () => {
    t.stub.respond(() => ({ body: saved }));
    await t.client.savedQueries.update(ID, { name: "New" });
    expect(t.stub.requests[0]).toMatchObject({
      method: "PATCH",
      path: `/v1/saved-queries/${ID}`,
      body: { name: "New" },
    });
  });

  it("delete sends DELETE and resolves void on a 204", async () => {
    t.stub.respond(() => ({ status: 204 }));
    expect(await t.client.savedQueries.delete(ID)).toBeUndefined();
    expect(t.stub.requests[0]).toMatchObject({
      method: "DELETE",
      path: `/v1/saved-queries/${ID}`,
    });
  });

  it("copy sends POST .../copy with the name", async () => {
    t.stub.respond(() => ({ status: 201, body: saved }));
    await t.client.savedQueries.copy(ID, { name: "Mine" });
    expect(t.stub.requests[0]).toMatchObject({
      method: "POST",
      path: `/v1/saved-queries/${ID}/copy`,
      body: { name: "Mine" },
    });
  });

  it("run sends POST .../run with no body as stored, or with paging", async () => {
    const result = { columns: [], rows: [], truncated: false, warnings: [] };
    t.stub.respond(() => ({ body: result }));
    expect(await t.client.savedQueries.run(ID)).toEqual(result);
    expect(t.stub.requests[0]).toMatchObject({
      method: "POST",
      path: `/v1/saved-queries/${ID}/run`,
    });
    expect(t.stub.requests[0].body).toBeUndefined();
    await t.client.savedQueries.run(ID, { limit: 10, offset: 5 });
    expect(t.stub.requests[1].body).toEqual({ limit: 10, offset: 5 });
  });

  it("run throws the 403 as a ZeteoError with its code", async () => {
    t.stub.respond(() => ({
      status: 403,
      body: { error: "saved_query_not_accessible", error_description: "x" },
    }));
    await expect(t.client.savedQueries.run(ID)).rejects.toMatchObject({
      status: 403,
      code: "saved_query_not_accessible",
    });
    await expect(t.client.savedQueries.run(ID)).rejects.toBeInstanceOf(
      ZeteoError
    );
  });

  it("listShares sends GET .../shares", async () => {
    const data = [
      { type: "user", id: USER, name: "Ada", email: null, shared_at: "t" },
    ];
    t.stub.respond(() => ({ body: { data } }));
    expect(await t.client.savedQueries.listShares(ID)).toEqual({ data });
    expect(t.stub.requests[0]).toMatchObject({
      method: "GET",
      path: `/v1/saved-queries/${ID}/shares`,
    });
  });

  it("replaceShares sends PUT .../shares with the principals", async () => {
    const out = {
      data: [],
      warnings: [{ type: "user", id: USER, accessible: false }],
    };
    t.stub.respond(() => ({ body: out }));
    const principals = [{ type: "user" as const, id: USER }];
    expect(await t.client.savedQueries.replaceShares(ID, principals)).toEqual(
      out
    );
    expect(t.stub.requests[0]).toMatchObject({
      method: "PUT",
      path: `/v1/saved-queries/${ID}/shares`,
      body: { principals },
    });
  });

  it("transfer sends POST .../transfer with the new owner", async () => {
    t.stub.respond(() => ({
      body: { data: saved, warning: { accessible: false } },
    }));
    const out = await t.client.savedQueries.transfer(ID, {
      user_id: USER,
      keep_access: false,
    });
    expect(out.warning).toEqual({ accessible: false });
    expect(t.stub.requests[0]).toMatchObject({
      method: "POST",
      path: `/v1/saved-queries/${ID}/transfer`,
      body: { user_id: USER, keep_access: false },
    });
  });

  describe("export", () => {
    const head = `${JSON.stringify({
      columns: [{ name: "id", type: "number" }],
      warnings: [],
      run_id: RUN,
    })}\n`;
    const end = `${JSON.stringify({ status: "complete", rows: 2 })}\n`;

    it("rows streams like client.export.rows, with the paging as the body", async () => {
      t.stub.respond(() => ({
        headers: { "x-zeteo-run-id": RUN },
        chunks: [head, "[1]\n[2]\n", end],
      }));
      const out = await t.client.savedQueries.export.rows(ID, { limit: 2 });
      expect(out.runId).toBe(RUN);
      expect(await readAll(out.rows)).toEqual([[1], [2]]);
      expect(await out.done).toEqual({ status: "complete", rows: 2 });
      expect(t.stub.requests[0]).toMatchObject({
        method: "POST",
        path: `/v1/saved-queries/${ID}/export`,
        query: { format: "ndjson" },
        body: { limit: 2 },
      });
      expect(t.stub.requests[0].headers["accept-encoding"]).toBe("gzip");
    });

    it("stream asks for csv and sends no body without paging", async () => {
      t.stub.respond(() => ({
        headers: { "x-zeteo-run-id": RUN },
        chunks: ["id\r\n1\r\n"],
      }));
      const out = await t.client.savedQueries.export.stream(ID, undefined, {
        format: "csv",
      });
      expect(out.runId).toBe(RUN);
      out.stream.resume();
      await new Promise((ok) => out.stream.once("close", ok));
      expect(t.stub.requests[0].query).toEqual({ format: "csv" });
      expect(t.stub.requests[0].body).toBeUndefined();
    });

    it("maps the 403 before the first byte to a ZeteoError", async () => {
      t.stub.respond(() => ({
        status: 403,
        body: { error: "saved_query_not_accessible" },
      }));
      await expect(t.client.savedQueries.export.rows(ID)).rejects.toMatchObject(
        {
          status: 403,
          code: "saved_query_not_accessible",
        }
      );
    });
  });

  it("sends the person's token under withToken", async () => {
    t.stub.respond(() => ({ body: saved }));
    await t.client.withToken("p-1").savedQueries.get(ID);
    expect(t.stub.requests[0].headers.authorization).toBe("Bearer p-1");
  });
});
