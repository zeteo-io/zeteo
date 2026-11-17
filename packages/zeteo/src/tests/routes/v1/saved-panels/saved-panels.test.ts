// @module-tag int
// @module-tag platform
import { BAR, TABLE, chartedQuery } from "../../../support/dashboards.js";
import { removeDashboardsOf } from "../../../support/panelDecisions.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeSources } from "../../../support/sources.js";
import { tokenFor } from "../../../support/tokens.js";
import { ENGINES } from "../../../support/engines.js";
import {
  DASHBOARDS_READ,
  DATA_READ,
} from "../../../../definitions/tereoDeclaration.js";
import {
  savedQueryOf,
  uniqueName,
  userWithOrders,
} from "../../../support/savedQueries.js";
import {
  savedPanelOf,
  savedPanelsCall,
  shareSavedPanelDirectly,
} from "../../../support/savedPanels.js";
import {
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../../../support/queries.js";

describe("/v1/saved-panels", () => {
  let source: SeededSource;
  const users: string[] = [];
  const user = async () => {
    const u = await userWithOrders(source, "all");
    users.push(u.id);
    return u;
  };
  const savedQuery = (token: string) =>
    savedQueryOf(token, source, { query: chartedQuery(source) });
  const ids = (r: { body: { data: Array<{ id: string }> } }) =>
    r.body.data.map((d) => d.id);

  beforeAll(async () => {
    source = await seedQuerySource(ENGINES[0]!, {}, "savedpanels");
  });
  afterAll(async () => {
    await removeDashboardsOf(users);
    await removeRunsOf(users);
    await removeSources([source.id]);
  });

  it("creates a saved panel from the caller's saved query", async () => {
    const owner = await user();
    const sq = await savedQuery(owner.token);
    const name = uniqueName("panel");
    const res = await savedPanelsCall("POST", "", owner.token, {
      name,
      description: "Revenue",
      saved_query_id: sq,
      chart: BAR,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      name,
      description: "Revenue",
      owner: { id: owner.id },
      state: "ok",
      chart: BAR,
      saved_query_id: sq,
      used_by: { dashboards: 0 },
      share_count: 0,
    });
    expect(res.body).not.toHaveProperty("time_column");
  });

  it("takes a time column that exists, and refuses one that does not", async () => {
    const owner = await user();
    const sq = await savedQuery(owner.token);
    const missing = await savedPanelsCall("POST", "", owner.token, {
      name: uniqueName(),
      saved_query_id: sq,
      chart: BAR,
      time_column: "no_such_column",
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe("invalid_panel");
    const timed = await savedQueryOf(owner.token, source, {
      query: {
        ...chartedQuery(source),
        select: ["id", "status", "total", "created_at"],
      },
    });
    const ok = await savedPanelsCall("POST", "", owner.token, {
      name: uniqueName(),
      saved_query_id: timed,
      chart: BAR,
      time_column: "created_at",
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.time_column).toBe("created_at");
  });

  it("refuses a chart that does not fit the saved query, with the problems", async () => {
    const owner = await user();
    const sq = await savedQuery(owner.token);
    const res = await savedPanelsCall("POST", "", owner.token, {
      name: uniqueName(),
      saved_query_id: sq,
      chart: { type: "bar", version: 1, x: "nope", y: ["total"] },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_panel");
    expect(res.body.problems).toEqual(expect.any(Array));
  });

  it("answers 404 for a saved query the caller cannot see", async () => {
    const owner = await user();
    const other = await user();
    const sq = await savedQuery(other.token);
    const res = await savedPanelsCall("POST", "", owner.token, {
      name: uniqueName(),
      saved_query_id: sq,
      chart: BAR,
    });
    expect(res.status).toBe(404);
  });

  it("refuses a second saved panel with the same name, whatever the case", async () => {
    const owner = await user();
    const sq = await savedQuery(owner.token);
    const name = uniqueName("Same");
    await savedPanelOf(owner.token, sq, { name });
    const res = await savedPanelsCall("POST", "", owner.token, {
      name: name.toUpperCase(),
      saved_query_id: sq,
      chart: TABLE,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("conflict");
  });

  it("lists what the caller owns and what is shared with them", async () => {
    const owner = await user();
    const recipient = await user();
    const sq = await savedQuery(owner.token);
    const mine = await savedPanelOf(owner.token, sq);
    await shareSavedPanelDirectly(mine, recipient.principal, owner.id);
    expect(ids(await savedPanelsCall("GET", "", owner.token))).toEqual([mine]);
    expect(ids(await savedPanelsCall("GET", "", recipient.token))).toEqual([]);
    const shared = await savedPanelsCall(
      "GET",
      "?scope=shared",
      recipient.token
    );
    expect(ids(shared)).toEqual([mine]);
    expect(shared.body.data[0]).toMatchObject({
      shared_at: expect.any(String),
    });
    expect(shared.body.data[0]).not.toHaveProperty("share_count");
    expect(shared.body.data[0]).not.toHaveProperty("used_by");
    const own = await savedPanelsCall("GET", "", owner.token);
    expect(own.body.data[0]).toMatchObject({ share_count: 1 });
  });

  it("pages and filters by name", async () => {
    const owner = await user();
    const sq = await savedQuery(owner.token);
    const a = await savedPanelOf(owner.token, sq, {
      name: uniqueName("alpha"),
    });
    const b = await savedPanelOf(owner.token, sq, { name: uniqueName("beta") });
    const first = await savedPanelsCall("GET", "?limit=1", owner.token);
    expect(ids(first)).toEqual([b]);
    const second = await savedPanelsCall(
      "GET",
      `?limit=1&cursor=${encodeURIComponent(first.body.next_cursor)}`,
      owner.token
    );
    expect(ids(second)).toEqual([a]);
    expect(ids(await savedPanelsCall("GET", "?q=ALPHA", owner.token))).toEqual([
      a,
    ]);
  });

  it("answers scope=all with 403 without zeteo.dashboards.read, and lists everything with it", async () => {
    const owner = await user();
    const sq = await savedQuery(owner.token);
    const id = await savedPanelOf(owner.token, sq);
    expect(
      (await savedPanelsCall("GET", "?scope=all", owner.token)).status
    ).toBe(403);
    const admin = tokenFor({ permissions: [DATA_READ, DASHBOARDS_READ] });
    const all = await savedPanelsCall("GET", "?scope=all", admin);
    expect(all.status).toBe(200);
    expect(ids(all)).toContain(id);
  });
});
