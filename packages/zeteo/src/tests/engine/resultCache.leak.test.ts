// @module-tag int
// @module-tag platform
// @module-tag security
import { SavedQueryNotAccessibleError } from "../../utils/errors.js";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { initializeTereo, stopTereo } from "../../utils/tereo.js";
import { closeAllSourcePools } from "../../sources/pools.js";
import { removeSources } from "../support/sources.js";
import { ENGINES } from "../support/engines.js";
import { describe } from "vitest";
import {
  clearDashboardKeys,
  removeDashboardsOf,
  runOnDashboard,
  seedDashboardQuery,
  type SeededDashboardQuery,
} from "../support/dashboardRuns.js";
import {
  grantTo,
  newQueryUser,
  removeGrant,
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../support/queries.js";

// A viewer whose grants change between two refreshes within the cache's time
// to live is never served the cached result: their run is planned with their
// grants as they are now, and a plan that fails (or differs) has no entry.
describe("the dashboard result cache across a change of grants", () => {
  let source: SeededSource;
  let seeded: SeededDashboardQuery;
  const owner = newQueryUser();
  const viewer = newQueryUser();
  const users = [owner.id, viewer.id];

  beforeAll(async () => {
    await initializeTereo();
    source = await seedQuerySource(ENGINES[0]!, {}, "dashcache");
    await grantTo(owner.principal, source.tables.orders!, ["id", "status"]);
    seeded = await seedDashboardQuery(source, owner.id);
  });
  afterEach(clearDashboardKeys);
  afterAll(async () => {
    await removeRunsOf(users);
    await removeDashboardsOf([owner.id]);
    await removeSources([source.id]);
    await closeAllSourcePools();
    await stopTereo();
  });

  it("refuses the viewer whose grant was removed, though the entry is still cached", async () => {
    const grant = await grantTo(viewer.principal, source.tables.orders!, [
      "id",
      "status",
    ]);
    await runOnDashboard(viewer.id, seeded);
    expect((await runOnDashboard(viewer.id, seeded)).cached_at).toBeDefined();

    await removeGrant(grant);
    const narrower = await grantTo(viewer.principal, source.tables.orders!, [
      "id",
    ]);
    await expect(runOnDashboard(viewer.id, seeded)).rejects.toBeInstanceOf(
      SavedQueryNotAccessibleError
    );
    // The entry itself is still there for those who may read it.
    expect((await runOnDashboard(owner.id, seeded)).cached_at).toBeDefined();
    await removeGrant(narrower);
  });

  it("refuses a viewer who was never granted the columns another viewer cached", async () => {
    await runOnDashboard(owner.id, seeded);
    await expect(runOnDashboard(viewer.id, seeded)).rejects.toBeInstanceOf(
      SavedQueryNotAccessibleError
    );
  });
});
