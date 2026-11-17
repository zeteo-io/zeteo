// @module-tag int
// @module-tag platform
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeSources } from "../../../../../support/sources.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { tokenFor } from "../../../../../support/tokens.js";
import { ENGINES } from "../../../../../support/engines.js";
import { randomUUID } from "crypto";
import {
  DASHBOARDS_READ,
  DATA_READ,
} from "../../../../../../definitions/tereoDeclaration.js";
import {
  savedQueriesCall,
  savedQueryOf,
  uniqueName,
  userWithOrders,
} from "../../../../../support/savedQueries.js";
import {
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../../../../../support/queries.js";

describe("GET /v1/saved-queries/:savedQueryId/dashboards", () => {
  let source: SeededSource;
  const users: string[] = [];
  const dashboardIds: string[] = [];
  const savedPanelIds: string[] = [];
  const where = (id: string, token: string) =>
    savedQueriesCall("GET", `/${id}/dashboards`, token);

  beforeAll(async () => {
    source = await seedQuerySource(ENGINES[0]!, {}, "useddashboards");
  });
  afterAll(async () => {
    await prisma.dashboard.deleteMany({ where: { id: { in: dashboardIds } } });
    await prisma.savedPanel.deleteMany({
      where: { id: { in: savedPanelIds } },
    });
    await removeRunsOf(users);
    await removeSources([source.id]);
  });

  it("lists the dashboards and saved panels using it, for an admin", async () => {
    const owner = await userWithOrders(source);
    users.push(owner.id);
    const id = await savedQueryOf(owner.token, source);
    const dashboard = await prisma.dashboard.create({
      data: {
        ownerId: owner.id,
        name: uniqueName("dash"),
        panels: {
          create: [
            { kind: "own", x: 0, y: 0, w: 4, h: 3, savedQueryId: id },
            { kind: "own", x: 4, y: 0, w: 4, h: 3, savedQueryId: id },
          ],
        },
      },
    });
    dashboardIds.push(dashboard.id);
    const panel = await prisma.savedPanel.create({
      data: {
        ownerId: owner.id,
        name: uniqueName("panel"),
        savedQueryId: id,
        chart: { type: "table" },
      },
    });
    savedPanelIds.push(panel.id);
    const other = await savedQueryOf(owner.token, source);
    const admin = tokenFor({ permissions: [DASHBOARDS_READ] });
    const res = await where(id, admin);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data).toEqual(
      expect.arrayContaining([
        {
          type: "dashboard",
          id: dashboard.id,
          name: dashboard.name,
          owner: {
            id: owner.id,
            name: expect.toSatisfy((n) => n === null || typeof n === "string"),
          },
        },
        {
          type: "saved_panel",
          id: panel.id,
          name: panel.name,
          owner: {
            id: owner.id,
            name: expect.toSatisfy((n) => n === null || typeof n === "string"),
          },
        },
      ])
    );
    expect((await where(other, admin)).body.data).toEqual([]);
  });

  it("is a 403 to an owner without the permission", async () => {
    const owner = await userWithOrders(source);
    users.push(owner.id);
    const id = await savedQueryOf(owner.token, source);
    const res = await where(id, owner.token);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
    const reader = tokenFor({ permissions: [DATA_READ] });
    expect((await where(id, reader)).status).toBe(403);
  });

  it("is a 404 for a saved query that does not exist", async () => {
    const admin = tokenFor({ permissions: [DASHBOARDS_READ] });
    const res = await where(randomUUID(), admin);
    expect(res.status).toBe(404);
  });
});
