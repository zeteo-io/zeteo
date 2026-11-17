import { useStubbedClient } from "../support/callContext.js";
import { describe, expect, it } from "vitest";
import { ZeteoError } from "../../errors.js";
import type {
  Dashboard,
  DashboardSummary,
  Panel,
  PanelLine,
} from "../../types/dashboards.js";

const ID = "11111111-1111-4111-8111-111111111111";
const PANEL = "33333333-3333-4333-8333-333333333333";
const USER = "22222222-2222-4222-8222-222222222222";
const SQ = "44444444-4444-4444-8444-444444444444";

const summary: DashboardSummary = {
  id: ID,
  name: "Sales",
  description: "",
  owner: { id: USER, name: "Ada" },
  time_range: "last_30_days",
  refresh_seconds: null,
  theme: "auto",
  created_at: "2026-11-17T10:00:00.000Z",
  updated_at: "2026-11-17T10:00:00.000Z",
};
const panel: Panel = {
  id: PANEL,
  kind: "own",
  x: 0,
  y: 0,
  w: 3,
  h: 2,
  title: "Revenue",
  state: "ok",
  chart: { type: "stat", version: 1, value: "revenue" },
  saved_query_id: SQ,
};
const dashboard: Dashboard = { ...summary, panels: [panel] };

const collect = async (lines: AsyncIterable<PanelLine>) => {
  const out: PanelLine[] = [];
  for await (const line of lines) out.push(line);
  return out;
};

describe("dashboards", () => {
  const t = useStubbedClient();

  it("list sends GET /v1/dashboards with its filters", async () => {
    t.stub.respond(() => ({ body: { data: [summary], next_cursor: null } }));
    const page = await t.client.dashboards.list({
      scope: "all",
      q: "sal",
      owner_id: USER,
      limit: 5,
      cursor: "c",
    });
    expect(page.data).toEqual([summary]);
    expect(t.stub.requests[0]).toMatchObject({
      method: "GET",
      path: "/v1/dashboards",
      query: {
        scope: "all",
        q: "sal",
        owner_id: USER,
        limit: "5",
        cursor: "c",
      },
    });
  });

  it("list without options sends no query", async () => {
    t.stub.respond(() => ({ body: { data: [], next_cursor: null } }));
    await t.client.dashboards.list();
    expect(t.stub.requests[0].query).toEqual({});
  });

  it("create sends POST with the panels as given", async () => {
    t.stub.respond(() => ({ status: 201, body: dashboard }));
    const body = {
      name: "Sales",
      time_range: "last_30_days" as const,
      panels: [
        {
          kind: "own" as const,
          saved_query_id: SQ,
          chart: {
            type: "stat" as const,
            version: 1 as const,
            value: "revenue",
          },
          w: 3,
        },
        { kind: "linked" as const, saved_panel_id: ID },
      ],
    };
    expect(await t.client.dashboards.create(body)).toEqual(dashboard);
    expect(t.stub.requests[0]).toMatchObject({
      method: "POST",
      path: "/v1/dashboards",
      body,
    });
  });

  it("create throws invalid_panel with its problems", async () => {
    t.stub.respond(() => ({
      status: 400,
      body: {
        error: "invalid_panel",
        error_description: "The panel's settings do not fit its saved query",
        problems: [{ setting: "value", problem: "missing_column" }],
      },
    }));
    const error = await t.client.dashboards
      .create({ name: "n" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ZeteoError);
    expect(error).toMatchObject({
      status: 400,
      code: "invalid_panel",
      problems: [{ setting: "value", problem: "missing_column" }],
    });
  });

  it("get sends GET by id and returns null on a 404", async () => {
    t.stub.respond(() => ({ body: dashboard }));
    expect(await t.client.dashboards.get(ID)).toEqual(dashboard);
    expect(t.stub.requests[0]).toMatchObject({
      method: "GET",
      path: `/v1/dashboards/${ID}`,
    });
    t.stub.respond(() => ({ status: 404, body: { error: "not_found" } }));
    expect(await t.client.dashboards.get(ID)).toBeNull();
  });

  it("update sends PATCH with panels by id and new", async () => {
    t.stub.respond(() => ({ body: dashboard }));
    const body = {
      theme: "dark" as const,
      refresh_seconds: null,
      panels: [
        { id: PANEL, x: 3, y: 0, title: null },
        { kind: "linked" as const, saved_panel_id: ID },
      ],
    };
    await t.client.dashboards.update(ID, body);
    expect(t.stub.requests[0]).toMatchObject({
      method: "PATCH",
      path: `/v1/dashboards/${ID}`,
      body,
    });
  });

  it("delete sends DELETE and resolves void on a 204", async () => {
    t.stub.respond(() => ({ status: 204 }));
    expect(await t.client.dashboards.delete(ID)).toBeUndefined();
    expect(t.stub.requests[0]).toMatchObject({
      method: "DELETE",
      path: `/v1/dashboards/${ID}`,
    });
  });

  it("copy sends POST .../copy with the name", async () => {
    t.stub.respond(() => ({ status: 201, body: dashboard }));
    await t.client.dashboards.copy(ID, { name: "Mine" });
    expect(t.stub.requests[0]).toMatchObject({
      method: "POST",
      path: `/v1/dashboards/${ID}/copy`,
      body: { name: "Mine" },
    });
  });

  it("listShares and replaceShares send GET and PUT .../shares", async () => {
    const data = [
      { type: "user", id: USER, name: "Ada", email: null, shared_at: "t" },
    ];
    t.stub.respond(() => ({ body: { data } }));
    expect(await t.client.dashboards.listShares(ID)).toEqual({ data });
    expect(t.stub.requests[0]).toMatchObject({
      method: "GET",
      path: `/v1/dashboards/${ID}/shares`,
    });
    const principals = [{ type: "user" as const, id: USER }];
    expect(await t.client.dashboards.replaceShares(ID, principals)).toEqual({
      data,
    });
    expect(t.stub.requests[1]).toMatchObject({
      method: "PUT",
      path: `/v1/dashboards/${ID}/shares`,
      body: { principals },
    });
  });

  it("transfer sends POST .../transfer and returns the dashboard", async () => {
    t.stub.respond(() => ({ body: dashboard }));
    const out = await t.client.dashboards.transfer(ID, {
      user_id: USER,
      keep_access: false,
    });
    expect(out).toEqual(dashboard);
    expect(t.stub.requests[0]).toMatchObject({
      method: "POST",
      path: `/v1/dashboards/${ID}/transfer`,
      body: { user_id: USER, keep_access: false },
    });
  });

  describe("panels", () => {
    it("addPanel sends POST .../panels with the panel", async () => {
      t.stub.respond(() => ({ status: 201, body: panel }));
      const input = { kind: "linked" as const, saved_panel_id: ID, title: "T" };
      expect(await t.client.dashboards.addPanel(ID, input)).toEqual(panel);
      expect(t.stub.requests[0]).toMatchObject({
        method: "POST",
        path: `/v1/dashboards/${ID}/panels`,
        body: input,
      });
    });

    it("updatePanel sends PATCH .../panels/{id}", async () => {
      t.stub.respond(() => ({ body: panel }));
      await t.client.dashboards.updatePanel(ID, PANEL, {
        time_column: null,
        w: 6,
      });
      expect(t.stub.requests[0]).toMatchObject({
        method: "PATCH",
        path: `/v1/dashboards/${ID}/panels/${PANEL}`,
        body: { time_column: null, w: 6 },
      });
    });

    it("removePanel sends DELETE .../panels/{id}", async () => {
      t.stub.respond(() => ({ status: 204 }));
      expect(await t.client.dashboards.removePanel(ID, PANEL)).toBeUndefined();
      expect(t.stub.requests[0]).toMatchObject({
        method: "DELETE",
        path: `/v1/dashboards/${ID}/panels/${PANEL}`,
      });
    });

    it("detachPanel sends POST .../detach with no body", async () => {
      t.stub.respond(() => ({ body: panel }));
      expect(await t.client.dashboards.detachPanel(ID, PANEL)).toEqual(panel);
      expect(t.stub.requests[0]).toMatchObject({
        method: "POST",
        path: `/v1/dashboards/${ID}/panels/${PANEL}/detach`,
      });
      expect(t.stub.requests[0].body).toBeUndefined();
    });

    it("savePanel sends POST .../save and returns the saved panel", async () => {
      const saved = { id: ID, name: "Revenue", state: "ok" };
      t.stub.respond(() => ({ status: 201, body: saved }));
      expect(
        await t.client.dashboards.savePanel(ID, PANEL, { name: "Revenue" })
      ).toEqual(saved);
      expect(t.stub.requests[0]).toMatchObject({
        method: "POST",
        path: `/v1/dashboards/${ID}/panels/${PANEL}/save`,
        body: { name: "Revenue" },
      });
    });
  });

  describe("run", () => {
    const first: PanelLine = {
      panel_id: PANEL,
      state: "ok",
      result: {
        columns: [{ name: "revenue", type: "number" }],
        rows: [["1200.50"]],
        truncated: false,
      },
    };
    const second: PanelLine = {
      panel_id: ID,
      state: "not_accessible",
      message: "You need expanded permissions to run this saved query.",
    };
    const third: PanelLine = {
      panel_id: SQ,
      state: "ok",
      error: { error: "query_timeout", error_description: "Too slow" },
    };
    const body = [first, second, third, { done: true }]
      .map((line) => `${JSON.stringify(line)}\n`)
      .join("");

    it("yields each panel's line from a body split mid-line", async () => {
      // Cuts fall inside the second line and inside the third's key.
      const cut1 = body.indexOf(second.panel_id) + 5;
      const cut2 = body.indexOf('"error"') + 2;
      t.stub.respond(() => ({
        chunks: [body.slice(0, cut1), body.slice(cut1, cut2), body.slice(cut2)],
      }));
      expect(await collect(t.client.dashboards.run(ID))).toEqual([
        first,
        second,
        third,
      ]);
      expect(t.stub.requests[0]).toMatchObject({
        method: "POST",
        path: `/v1/dashboards/${ID}/run`,
      });
      expect(t.stub.requests[0].body).toBeUndefined();
      expect(t.stub.requests[0].headers["accept-encoding"]).toBe("gzip");
    });

    it("sends the panels and time range, null included", async () => {
      t.stub.respond(() => ({ chunks: ['{"done":true}\n'] }));
      await collect(
        t.client.dashboards.run(ID, { panels: [PANEL], time_range: null })
      );
      expect(t.stub.requests[0].body).toEqual({
        panels: [PANEL],
        time_range: null,
      });
    });

    it("does not send until iteration starts", async () => {
      t.stub.respond(() => ({ chunks: ['{"done":true}\n'] }));
      const lines = t.client.dashboards.run(ID);
      expect(t.stub.requests).toHaveLength(0);
      await collect(lines);
      expect(t.stub.requests).toHaveLength(1);
    });

    it("throws a ZeteoError for a failure before the stream", async () => {
      t.stub.respond(() => ({
        status: 404,
        body: { error: "not_found", error_description: "Dashboard not found" },
      }));
      await expect(collect(t.client.dashboards.run(ID))).rejects.toMatchObject({
        status: 404,
        code: "not_found",
      });
    });

    it("throws when the stream ends without its done line", async () => {
      t.stub.respond(() => ({ chunks: [`${JSON.stringify(first)}\n`] }));
      const seen: PanelLine[] = [];
      const error = await (async () => {
        try {
          for await (const line of t.client.dashboards.run(ID)) {
            seen.push(line);
          }
        } catch (e) {
          return e;
        }
      })();
      expect(seen).toEqual([first]);
      expect(error).toBeInstanceOf(ZeteoError);
      expect(error).toMatchObject({ code: "dashboard_run_interrupted" });
    });

    it("throws when the connection is cut", async () => {
      t.stub.respond(() => ({
        chunks: [`${JSON.stringify(first)}\n`, '{"panel_id":"x'],
        cutAfterChunks: true,
      }));
      await expect(collect(t.client.dashboards.run(ID))).rejects.toMatchObject({
        code: "dashboard_run_interrupted",
      });
    });

    it("throws on a line that is not a panel's", async () => {
      t.stub.respond(() => ({ chunks: ["[1,2]\n"] }));
      await expect(collect(t.client.dashboards.run(ID))).rejects.toMatchObject({
        code: "dashboard_run_interrupted",
      });
    });

    it("closes the connection when the reader stops early", async () => {
      t.stub.respond(() => ({
        chunks: [`${JSON.stringify(first)}\n`, `${JSON.stringify(second)}\n`],
        holdOpen: true,
      }));
      for await (const line of t.client.dashboards.run(ID)) {
        expect(line).toEqual(first);
        break;
      }
      await new Promise((ok) => setTimeout(ok, 100));
      expect(t.stub.cutByClient).toEqual([`/v1/dashboards/${ID}/run`]);
    });
  });

  it("sends the person's token under withToken", async () => {
    t.stub.respond(() => ({ body: dashboard }));
    await t.client.withToken("p-1").dashboards.get(ID);
    expect(t.stub.requests[0].headers.authorization).toBe("Bearer p-1");
  });
});
