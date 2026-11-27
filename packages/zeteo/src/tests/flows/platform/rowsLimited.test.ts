// @module-tag int
// @module-tag platform
import { savedQueriesCall, savedQueryOf } from "../../support/savedQueries.js";
import { savedPanelOf, savedPanelsCall } from "../../support/savedPanels.js";
import { removeDashboardsOf } from "../../support/panelDecisions.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeSources } from "../../support/sources.js";
import { ENGINES } from "../../support/engines.js";
import {
  addPanel,
  chartedQuery,
  dashboardOf,
  ownPanel,
} from "../../support/dashboards.js";
import {
  ndjsonLines,
  newExportUser,
  postExport,
} from "../../support/exports.js";
import {
  grantTo,
  postQuery,
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../../support/queries.js";

// Every result says whether a row rule limited the rows it read: a query, a
// saved query's run, a saved panel's preview, a dashboard panel's line and
// an export (in a header).

describe("results say when the caller's rows are limited", () => {
  let source: SeededSource;
  const limited = newExportUser();
  const unlimited = newExportUser();
  const users = [limited, unlimited];

  beforeAll(async () => {
    source = await seedQuerySource(
      ENGINES[0]!,
      { export_enabled: true, export_row_cap: 1_000_000 },
      "rowslimited"
    );
    const { orders, customers } = source.tables;
    await grantTo(limited.principal, orders!, "all", {
      access: "rule",
      rule: { status: { in: ["paid"] } },
    });
    await grantTo(limited.principal, customers!, "all");
    await grantTo(unlimited.principal, orders!, "all");
    await grantTo(unlimited.principal, customers!, "all");
  });
  afterAll(async () => {
    const ids = users.map((u) => u.id);
    await removeDashboardsOf(ids);
    await removeRunsOf(ids);
    await removeSources([source.id]);
  });

  const ordersQuery = () => ({
    source: source.slug,
    from: "orders",
    select: ["id", "status"],
  });

  it("POST /v1/query: rows_limited when a table read has a rule", async () => {
    const limitedRes = await postQuery(limited.token, ordersQuery());
    expect(limitedRes.status, JSON.stringify(limitedRes.body)).toBe(200);
    expect(limitedRes.body.rows_limited).toBe(true);

    const free = await postQuery(unlimited.token, ordersQuery());
    expect(free.body.rows_limited).toBe(false);

    // A table with no rule, for the same caller.
    const customers = await postQuery(limited.token, {
      source: source.slug,
      from: "customers",
      select: ["id"],
    });
    expect(customers.body.rows_limited).toBe(false);
  });

  it("a saved query's run and a saved panel's preview carry rows_limited", async () => {
    for (const [user, expected] of [
      [limited, true],
      [unlimited, false],
    ] as const) {
      const sq = await savedQueryOf(user.token, source, {
        query: chartedQuery(source),
      });
      const run = await savedQueriesCall("POST", `/${sq}/run`, user.token, {});
      expect(run.status, JSON.stringify(run.body)).toBe(200);
      expect(run.body.rows_limited).toBe(expected);

      const panel = await savedPanelOf(user.token, sq);
      const preview = await savedPanelsCall(
        "POST",
        `/${panel}/preview`,
        user.token,
        {}
      );
      expect(preview.status, JSON.stringify(preview.body)).toBe(200);
      expect(preview.body.rows_limited).toBe(expected);
    }
  });

  it("a dashboard panel's line carries rows_limited", async () => {
    for (const [user, expected] of [
      [limited, true],
      [unlimited, false],
    ] as const) {
      const sq = await savedQueryOf(user.token, source, {
        query: chartedQuery(source),
      });
      const dashboardId = await dashboardOf(user.token);
      const added = await addPanel(user.token, dashboardId, ownPanel(sq));
      expect(added.status, JSON.stringify(added.body)).toBe(201);
      const res = await postExport({
        token: user.token,
        body: {},
        path: `/v1/dashboards/${dashboardId}/run`,
      });
      expect(res.status, res.text).toBe(200);
      const [line] = ndjsonLines(res.text) as Array<Record<string, unknown>>;
      expect(line).toMatchObject({ state: "ok", rows_limited: expected });
    }
  });

  it("an export says so in X-Zeteo-Rows-Limited, and only when limited", async () => {
    for (const search of ["", "format=csv"]) {
      const res = await postExport({
        token: limited.token,
        body: ordersQuery(),
        search,
      });
      expect(res.status, res.text).toBe(200);
      expect(res.headers["x-zeteo-rows-limited"]).toBe("true");

      const free = await postExport({
        token: unlimited.token,
        body: ordersQuery(),
        search,
      });
      expect(free.status, free.text).toBe(200);
      expect(free.headers["x-zeteo-rows-limited"]).toBeUndefined();
    }
  });
});
