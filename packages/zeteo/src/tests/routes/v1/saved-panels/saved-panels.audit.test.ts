// @module-tag int
// @module-tag platform
import { removeDashboardsOf } from "../../../support/panelDecisions.js";
import { auditRows, removeSources } from "../../../support/sources.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BAR, chartedQuery } from "../../../support/dashboards.js";
import { savedPanelsCall } from "../../../support/savedPanels.js";
import { prisma } from "../../../../utils/db/prisma.js";
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
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../../../support/queries.js";

describe("saved panel audit entries", () => {
  let source: SeededSource;
  const users: string[] = [];
  const user = async () => {
    const u = await userWithOrders(source, "all");
    users.push(u.id);
    await addUserToDirectory(u.id);
    return u;
  };

  beforeAll(async () => {
    source = await seedQuerySource(ENGINES[0]!, {}, "savedpanelaudit");
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
    await prisma.savedQuery.update({
      where: { id: sq },
      data: { availableForDashboards: true, availableOrganizationId: null },
    });
    const name = uniqueName("audited");
    const created = await savedPanelsCall("POST", "", owner.token, {
      name,
      saved_query_id: sq,
      chart: BAR,
    });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    await savedPanelsCall("PATCH", `/${id}`, owner.token, {
      name: `${name} v2`,
      chart: { type: "table", version: 1 },
    });
    await savedPanelsCall("PUT", `/${id}/shares`, owner.token, {
      principals: [other.principal],
    });
    const copy = await savedPanelsCall("POST", `/${id}/copy`, other.token, {
      name: uniqueName("copy"),
    });
    await savedPanelsCall("POST", `/${id}/transfer`, owner.token, {
      user_id: next.id,
    });
    await savedPanelsCall("DELETE", `/${id}`, next.token);

    const rows = await auditRows(id);
    expect(rows.map((r) => r.payload.metadata.event)).toEqual([
      "zeteo.saved_panel.created",
      "zeteo.saved_panel.updated",
      "zeteo.saved_panel.shared",
      "zeteo.saved_panel.transferred",
      "zeteo.saved_panel.deleted",
    ]);
    expect(rows[0]!.payload).toMatchObject({
      action: "CREATE",
      entityType: "saved_panel",
      userId: owner.id,
      metadata: { name, owner_id: owner.id },
    });
    expect(rows[1]!.payload.metadata).toMatchObject({
      name: `${name} v2`,
      previous_name: name,
      changed: ["name", "chart"],
    });
    expect(rows[2]!.payload.metadata).toMatchObject({
      added: [{ type: "user", id: other.id }],
      removed: [],
    });
    expect(rows[3]!.payload.metadata).toMatchObject({
      from: owner.id,
      to: next.id,
      keep_access: true,
    });
    expect(rows[4]!.payload).toMatchObject({ userId: next.id });
    expect(copy.status, JSON.stringify(copy.body)).toBe(201);
    expect((await auditRows(copy.body.id))[0]!.payload).toMatchObject({
      action: "CREATE",
      userId: other.id,
      metadata: {
        event: "zeteo.saved_panel.copied",
        copied_from: id,
        owner_id: other.id,
      },
    });
    const everything = JSON.stringify(rows);
    for (const secret of ['"bar"', '"version"', "total"]) {
      expect(everything).not.toContain(secret);
    }
  });
});
