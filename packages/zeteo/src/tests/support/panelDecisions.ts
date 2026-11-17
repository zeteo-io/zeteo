import { DATA_READ } from "../../definitions/tereoDeclaration.js";
import type { PanelInput } from "../../utils/db/dashboards.js";
import type { Caller } from "../../middleware/auth.js";
import type { Prisma } from "../../utils/db/prisma.js";
import { db, prisma } from "../../utils/db/index.js";
import type { SeededSource } from "./queries.js";
import { uniqueName } from "./savedQueries.js";

// Fixtures for deciding panels: dashboards, saved panels and saved queries
// written straight to the database, as the routes would leave them.

/** A caller with `zeteo.data.read`, signed in to `organizationId`. */
export const viewer = (
  userId: string,
  organizationId: string | null = null
): Caller => ({
  userId,
  organizationId,
  permissions: [DATA_READ],
  isServiceAccount: false,
});

/** A saved query of `ownerId` on `on`, written directly (no planning as its owner). */
export const savedQueryRow = (
  ownerId: string,
  on: SeededSource,
  query: Prisma.InputJsonObject,
  fields: {
    availableForDashboards?: boolean;
    availableOrganizationId?: string | null;
  } = {}
) =>
  db.savedQueries.create({
    ownerId,
    sourceId: on.id,
    name: uniqueName("query"),
    description: "",
    query: { source: on.slug, ...query },
    ...fields,
  });

export const savedPanelRow = (
  ownerId: string,
  savedQueryId: string | null,
  chart: Prisma.InputJsonObject,
  timeColumn: string | null = null
) =>
  db.savedPanels.create({
    ownerId,
    name: uniqueName("panel"),
    description: "",
    savedQueryId,
    chart,
    timeColumn,
  });

/** A dashboard of `ownerId` with these panels, read back with them. */
export const dashboardWith = async (
  ownerId: string,
  panels: Array<Partial<PanelInput> & Pick<PanelInput, "kind">>
) => {
  const dashboard = await db.dashboards.create({
    ownerId,
    name: uniqueName("dashboard"),
    description: "",
  });
  let y = 0;
  for (const panel of panels) {
    await db.dashboards.addPanel(dashboard.id, {
      x: 0,
      y: y++,
      w: 6,
      h: 4,
      ...panel,
    });
  }
  return (await db.dashboards.findWithPanels(dashboard.id))!;
};

/** Removes the dashboards and saved panels of these owners. */
export const removeDashboardsOf = async (ownerIds: string[]) => {
  await prisma.dashboard.deleteMany({ where: { ownerId: { in: ownerIds } } });
  await prisma.savedPanel.deleteMany({ where: { ownerId: { in: ownerIds } } });
};
