import type { SavedPanel } from "../../types/savedPanels.js";
import { useStubbedClient } from "../support/callContext.js";
import { describe, expect, it } from "vitest";
import { ZeteoError } from "../../errors.js";

const ID = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const SQ = "44444444-4444-4444-8444-444444444444";

const saved: SavedPanel = {
  id: ID,
  name: "Revenue",
  description: "",
  owner: { id: USER, name: "Ada" },
  state: "ok",
  chart: { type: "stat", version: 1, value: "revenue" },
  saved_query_id: SQ,
  created_at: "2026-11-17T10:00:00.000Z",
  updated_at: "2026-11-17T10:00:00.000Z",
};

describe("savedPanels", () => {
  const t = useStubbedClient();

  it("list sends GET /v1/saved-panels with its filters", async () => {
    t.stub.respond(() => ({ body: { data: [saved], next_cursor: null } }));
    const page = await t.client.savedPanels.list({
      scope: "shared",
      q: "rev",
      limit: 5,
      cursor: "c",
    });
    expect(page.data).toEqual([saved]);
    expect(t.stub.requests[0]).toMatchObject({
      method: "GET",
      path: "/v1/saved-panels",
      query: { scope: "shared", q: "rev", limit: "5", cursor: "c" },
    });
  });

  it("create sends POST with the body as given", async () => {
    t.stub.respond(() => ({ status: 201, body: saved }));
    const body = {
      name: "Revenue",
      saved_query_id: SQ,
      chart: {
        type: "line" as const,
        version: 1 as const,
        x: "day",
        y: ["revenue"],
      },
      time_column: "created_at",
    };
    expect(await t.client.savedPanels.create(body)).toEqual(saved);
    expect(t.stub.requests[0]).toMatchObject({
      method: "POST",
      path: "/v1/saved-panels",
      body,
    });
  });

  it("get sends GET by id and returns null on a 404", async () => {
    t.stub.respond(() => ({ body: saved }));
    expect(await t.client.savedPanels.get(ID)).toEqual(saved);
    expect(t.stub.requests[0]).toMatchObject({
      method: "GET",
      path: `/v1/saved-panels/${ID}`,
    });
    t.stub.respond(() => ({ status: 404, body: { error: "not_found" } }));
    expect(await t.client.savedPanels.get(ID)).toBeNull();
  });

  it("update sends PATCH with the changes", async () => {
    t.stub.respond(() => ({ body: saved }));
    await t.client.savedPanels.update(ID, { name: "New", time_column: null });
    expect(t.stub.requests[0]).toMatchObject({
      method: "PATCH",
      path: `/v1/saved-panels/${ID}`,
      body: { name: "New", time_column: null },
    });
  });

  it("delete sends DELETE and resolves void on a 204", async () => {
    t.stub.respond(() => ({ status: 204 }));
    expect(await t.client.savedPanels.delete(ID)).toBeUndefined();
    expect(t.stub.requests[0]).toMatchObject({
      method: "DELETE",
      path: `/v1/saved-panels/${ID}`,
    });
  });

  it("copy sends POST .../copy with the name", async () => {
    t.stub.respond(() => ({ status: 201, body: saved }));
    await t.client.savedPanels.copy(ID, { name: "Mine" });
    expect(t.stub.requests[0]).toMatchObject({
      method: "POST",
      path: `/v1/saved-panels/${ID}/copy`,
      body: { name: "Mine" },
    });
  });

  it("listShares and replaceShares send GET and PUT .../shares", async () => {
    const data = [{ type: "group", id: USER, name: "Sales", shared_at: "t" }];
    t.stub.respond(() => ({ body: { data } }));
    expect(await t.client.savedPanels.listShares(ID)).toEqual({ data });
    const principals = [{ type: "group" as const, id: USER }];
    await t.client.savedPanels.replaceShares(ID, principals);
    expect(t.stub.requests[0]).toMatchObject({
      method: "GET",
      path: `/v1/saved-panels/${ID}/shares`,
    });
    expect(t.stub.requests[1]).toMatchObject({
      method: "PUT",
      path: `/v1/saved-panels/${ID}/shares`,
      body: { principals },
    });
  });

  it("transfer sends POST .../transfer and returns the saved panel", async () => {
    t.stub.respond(() => ({ body: saved }));
    expect(await t.client.savedPanels.transfer(ID, { user_id: USER })).toEqual(
      saved
    );
    expect(t.stub.requests[0]).toMatchObject({
      method: "POST",
      path: `/v1/saved-panels/${ID}/transfer`,
      body: { user_id: USER },
    });
  });

  it("preview sends POST .../preview with no body, or a time range", async () => {
    const result = {
      columns: [],
      rows: [],
      truncated: false,
      warnings: [],
      run_id: ID,
    };
    t.stub.respond(() => ({ body: result }));
    expect(await t.client.savedPanels.preview(ID)).toEqual(result);
    expect(t.stub.requests[0]).toMatchObject({
      method: "POST",
      path: `/v1/saved-panels/${ID}/preview`,
    });
    expect(t.stub.requests[0].body).toBeUndefined();
    await t.client.savedPanels.preview(ID, { time_range: "this_month" });
    expect(t.stub.requests[1].body).toEqual({ time_range: "this_month" });
  });

  it("preview throws the 403 as a ZeteoError with its code", async () => {
    t.stub.respond(() => ({
      status: 403,
      body: { error: "saved_query_not_accessible", error_description: "x" },
    }));
    const error = await t.client.savedPanels
      .preview(ID)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ZeteoError);
    expect(error).toMatchObject({
      status: 403,
      code: "saved_query_not_accessible",
    });
  });
});
