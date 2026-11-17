// @module-tag int
// @module-tag platform
import { removeDashboardsOf } from "../../../support/panelDecisions.js";
import { auditRows, removeSources } from "../../../support/sources.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENGINES } from "../../../support/engines.js";
import {
  savedQueryOf,
  uniqueName,
  userWithOrders,
} from "../../../support/savedQueries.js";
import {
  addUserToDirectory,
  clearDirectory,
} from "../../../support/principals.js";
import {
  addPanel,
  chartedQuery,
  createDashboard,
  dashboardsCall,
  ownPanel,
} from "../../../support/dashboards.js";
import {
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../../../support/queries.js";

describe("dashboard audit entries", () => {
  let source: SeededSource;
  const users: string[] = [];
  const user = async () => {
    const u = await userWithOrders(source, "all");
    users.push(u.id);
    await addUserToDirectory(u.id);
    return u;
  };

  beforeAll(async () => {
    source = await seedQuerySource(ENGINES[0]!, {}, "dashaudit");
  });
  afterAll(async () => {
    await clearDirectory();
    await removeDashboardsOf(users);
    await removeRunsOf(users);
    await removeSources([source.id]);
  });

  it("records each change with ids and names, never chart settings", async () => {
    const owner = await user();
    const next = await user();
    const other = await user();
    const sq = await savedQueryOf(owner.token, source, {
      query: chartedQuery(source),
    });
    const name = uniqueName("audited");
    const created = await createDashboard(owner.token, {
      name,
      panels: [ownPanel(sq, { title: "Secret revenue" })],
    });
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    await dashboardsCall("PATCH", `/${id}`, owner.token, {
      name: `${name} v2`,
      theme: "dark",
    });
    const added = await addPanel(owner.token, id, ownPanel(sq));
    await dashboardsCall(
      "PATCH",
      `/${id}/panels/${added.body.id}`,
      owner.token,
      {
        title: "Moved",
      }
    );
    await dashboardsCall(
      "DELETE",
      `/${id}/panels/${added.body.id}`,
      owner.token
    );
    await dashboardsCall("PUT", `/${id}/shares`, owner.token, {
      principals: [other.principal],
    });
    const copy = await dashboardsCall("POST", `/${id}/copy`, other.token, {
      name: uniqueName("copy"),
    });
    await dashboardsCall("POST", `/${id}/transfer`, owner.token, {
      user_id: next.id,
    });
    await dashboardsCall("DELETE", `/${id}`, next.token);

    const rows = await auditRows(id);
    const events = rows.map((r) => r.payload.metadata.event);
    expect(events).toEqual([
      "zeteo.dashboard.created",
      "zeteo.dashboard.updated",
      "zeteo.dashboard.updated",
      "zeteo.dashboard.updated",
      "zeteo.dashboard.updated",
      "zeteo.dashboard.shared",
      "zeteo.dashboard.transferred",
      "zeteo.dashboard.deleted",
    ]);
    expect(rows[0]!.payload).toMatchObject({
      action: "CREATE",
      entityType: "dashboard",
      userId: owner.id,
      metadata: { name, owner_id: owner.id, panel_count: 1 },
    });
    expect(rows[1]!.payload.metadata).toMatchObject({
      name: `${name} v2`,
      previous_name: name,
      changed: ["name", "theme"],
    });
    expect(rows[2]!.payload.metadata).toMatchObject({
      changed: ["panels"],
      panel_added: added.body.id,
    });
    expect(rows[3]!.payload.metadata).toMatchObject({
      changed: ["panels"],
      panel_changed: added.body.id,
    });
    expect(rows[4]!.payload.metadata).toMatchObject({
      changed: ["panels"],
      panel_removed: added.body.id,
    });
    expect(rows[5]!.payload.metadata).toMatchObject({
      added: [{ type: "user", id: other.id }],
      removed: [],
    });
    expect(rows[6]!.payload).toMatchObject({
      userId: owner.id,
      metadata: { from: owner.id, to: next.id, keep_access: true },
    });
    expect(rows[7]!.payload).toMatchObject({ userId: next.id });
    expect((await auditRows(copy.body.id as string))[0]!.payload).toMatchObject(
      {
        action: "CREATE",
        entityType: "dashboard",
        userId: other.id,
        metadata: {
          event: "zeteo.dashboard.copied",
          copied_from: id,
          owner_id: other.id,
        },
      }
    );
    const everything = JSON.stringify([
      ...rows,
      ...(await auditRows(copy.body.id as string)),
    ]);
    for (const secret of ['"chart"', '"bar"', "Secret revenue", "total"]) {
      expect(everything).not.toContain(secret);
    }
  });
});
