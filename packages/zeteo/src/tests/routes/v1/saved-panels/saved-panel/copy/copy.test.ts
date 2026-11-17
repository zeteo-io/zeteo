// @module-tag int
// @module-tag platform
import { removeDashboardsOf } from "../../../../../support/panelDecisions.js";
import { chartedQuery } from "../../../../../support/dashboards.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeSources } from "../../../../../support/sources.js";
import { ENGINES } from "../../../../../support/engines.js";
import {
  savedQueryOf,
  uniqueName,
  userWithOrders,
} from "../../../../../support/savedQueries.js";
import {
  savedPanelOf,
  savedPanelsCall,
  shareSavedPanelDirectly,
} from "../../../../../support/savedPanels.js";
import {
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../../../../../support/queries.js";

describe("POST /v1/saved-panels/:savedPanelId/copy", () => {
  let source: SeededSource;
  const users: string[] = [];
  const user = async () => {
    const u = await userWithOrders(source, "all");
    users.push(u.id);
    return u;
  };

  beforeAll(async () => {
    source = await seedQuerySource(ENGINES[0]!, {}, "savedpanelcopy");
  });
  afterAll(async () => {
    await removeDashboardsOf(users);
    await removeRunsOf(users);
    await removeSources([source.id]);
  });

  it("gives the copier their own saved panel on the same saved query", async () => {
    const owner = await user();
    const viewer = await user();
    // The copier owns the saved query too: the reach rule holds for them.
    const sq = await savedQueryOf(owner.token, source, {
      query: chartedQuery(source),
    });
    await prismaAvailable(sq);
    const id = await savedPanelOf(owner.token, sq, { description: "d" });
    await shareSavedPanelDirectly(id, viewer.principal, owner.id);
    const name = uniqueName("copy");
    const res = await savedPanelsCall("POST", `/${id}/copy`, viewer.token, {
      name,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      name,
      description: "d",
      owner: { id: viewer.id },
      saved_query_id: sq,
      state: "ok",
    });
    expect(res.body.id).not.toBe(id);
  });

  it("answers 404 for a saved panel the caller cannot see", async () => {
    const owner = await user();
    const stranger = await user();
    const sq = await savedQueryOf(owner.token, source, {
      query: chartedQuery(source),
    });
    const id = await savedPanelOf(owner.token, sq);
    const res = await savedPanelsCall("POST", `/${id}/copy`, stranger.token, {
      name: uniqueName(),
    });
    expect(res.status).toBe(404);
  });
});

const prismaAvailable = async (savedQueryId: string) => {
  const { prisma } = await import("../../../../../../utils/db/prisma.js");
  await prisma.savedQuery.update({
    where: { id: savedQueryId },
    data: { availableForDashboards: true, availableOrganizationId: null },
  });
};
