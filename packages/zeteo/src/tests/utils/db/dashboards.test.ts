// @module-tag int
// @module-tag platform
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeSources } from "../../support/sources.js";
import { db, prisma } from "../../../utils/db/index.js";
import { randomUUID } from "crypto";

const suffix = randomUUID().slice(0, 8);
const owner = randomUUID();
const other = randomUUID();
const userId = randomUUID();
const groupId = randomUUID();
const sourceIds: string[] = [];
let sourceId: string;

const query = { source: "x", from: "t", select: ["a"] };
const chart = { type: "bar", x: "a" };

const newDashboard = (ownerId: string, name: string) =>
  db.dashboards.create({ ownerId, name, description: "" });

const newSavedQuery = (name: string, extra: object = {}) =>
  db.savedQueries.create({
    ownerId: owner,
    sourceId,
    name,
    description: "",
    query,
    ...extra,
  });

describe("dashboards repository", () => {
  beforeAll(async () => {
    const source = await prisma.source.create({
      data: {
        slug: `db-${suffix}`,
        name: "Dashboards",
        type: "postgres",
        sealedSettings: {},
        schemas: [],
        createdBy: owner,
      },
    });
    sourceId = source.id;
    sourceIds.push(source.id);
  });

  afterAll(async () => {
    await prisma.dashboard.deleteMany({
      where: { ownerId: { in: [owner, other] } },
    });
    await prisma.savedPanel.deleteMany({
      where: { ownerId: { in: [owner, other] } },
    });
    await prisma.savedQuery.deleteMany({ where: { sourceId } });
    await removeSources(sourceIds);
  });

  it("refuses a second name for one owner that differs only in case", async () => {
    await newDashboard(owner, `Sales ${suffix}`);
    await expect(newDashboard(owner, `SALES ${suffix}`)).rejects.toMatchObject({
      code: "P2002",
    });
    await expect(newDashboard(other, `SALES ${suffix}`)).resolves.toBeDefined();
  });

  it("refuses a linked panel with a chart and a panel past the grid's edge", async () => {
    const d = await newDashboard(owner, `checks ${suffix}`);
    await expect(
      db.dashboards.addPanel(d.id, {
        kind: "linked",
        x: 0,
        y: 0,
        w: 4,
        h: 4,
        chart,
      })
    ).rejects.toThrow();
    await expect(
      db.dashboards.addPanel(d.id, {
        kind: "own",
        x: 9,
        y: 0,
        w: 4,
        h: 4,
        chart,
      })
    ).rejects.toThrow();
    await expect(
      db.dashboards.addPanel(d.id, {
        kind: "own",
        x: 8,
        y: 0,
        w: 4,
        h: 4,
        chart,
      })
    ).resolves.toBeDefined();
  });

  it("nulls a panel's saved query and a saved panel's when the saved query goes, and keeps a linked panel linked in kind", async () => {
    const sq = await newSavedQuery(`gone ${suffix}`);
    const d = await newDashboard(owner, `links ${suffix}`);
    const own = await db.dashboards.addPanel(d.id, {
      kind: "own",
      x: 0,
      y: 0,
      w: 4,
      h: 4,
      savedQueryId: sq.id,
      chart,
    });
    const sp = await db.savedPanels.create({
      ownerId: owner,
      name: `sp ${suffix}`,
      description: "",
      savedQueryId: sq.id,
      chart,
      timeColumn: null,
    });
    const linked = await db.dashboards.addPanel(d.id, {
      kind: "linked",
      x: 4,
      y: 0,
      w: 4,
      h: 4,
      savedPanelId: sp.id,
    });
    await db.savedQueries.remove(sq.id);
    expect(
      (await prisma.dashboardPanel.findUnique({ where: { id: own.id } }))
        ?.savedQueryId
    ).toBeNull();
    expect((await db.savedPanels.findById(sp.id))?.savedQueryId).toBeNull();
    await db.savedPanels.remove(sp.id);
    const after = await prisma.dashboardPanel.findUnique({
      where: { id: linked.id },
    });
    expect(after).toMatchObject({ savedPanelId: null, kind: "linked" });
  });

  it("lists shared dashboards by user or group, never the user's own", async () => {
    const byUser = await newDashboard(owner, `by-user ${suffix}`);
    const byGroup = await newDashboard(owner, `by-group ${suffix}`);
    const unshared = await newDashboard(owner, `unshared ${suffix}`);
    const mine = await newDashboard(userId, `mine ${suffix}`);
    await prisma.$transaction(async (tx) => {
      await db.dashboards.replaceShares(
        tx,
        byUser.id,
        [{ type: "user", id: userId }],
        owner
      );
      await db.dashboards.replaceShares(
        tx,
        byGroup.id,
        [{ type: "group", id: groupId }],
        owner
      );
      await db.dashboards.replaceShares(
        tx,
        mine.id,
        [{ type: "user", id: userId }],
        owner
      );
    });
    const { rows } = await db.dashboards.listVisibleTo({
      userId,
      groupIds: [groupId],
      scope: "shared",
      limit: 50,
    });
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([byUser.id, byGroup.id]));
    expect(ids).not.toContain(unshared.id);
    expect(ids).not.toContain(mine.id);
  });

  it("counts a dashboard once however many panels use a saved query", async () => {
    const sq = await newSavedQuery(`count ${suffix}`);
    const d1 = await newDashboard(owner, `count1 ${suffix}`);
    const d2 = await newDashboard(owner, `count2 ${suffix}`);
    const panel = (y: number, savedQueryId: string) => ({
      kind: "own" as const,
      x: 0,
      y,
      w: 4,
      h: 4,
      savedQueryId,
      chart,
    });
    await prisma.$transaction(async (tx) => {
      await db.dashboards.replacePanels(tx, d1.id, [
        panel(0, sq.id),
        panel(4, sq.id),
      ]);
      await db.dashboards.replacePanels(tx, d2.id, [panel(0, sq.id)]);
    });
    expect(await db.dashboards.countUsingSavedQuery(sq.id)).toBe(2);
    const listed = await db.dashboards.listUsingSavedQuery(sq.id);
    expect(listed.map((d) => d.id).sort()).toEqual([d1.id, d2.id].sort());
    const loaded = await db.dashboards.findWithPanels(d1.id);
    expect(loaded?.panels.map((p) => p.y)).toEqual([0, 4]);
  });

  it("lists the saved queries available in one organization only, null matching null", async () => {
    const org = randomUUID();
    const inOrg = await newSavedQuery(`org ${suffix}`, {
      availableForDashboards: true,
      availableOrganizationId: org,
    });
    const noOrg = await newSavedQuery(`noorg ${suffix}`, {
      availableForDashboards: true,
      availableOrganizationId: null,
    });
    const off = await newSavedQuery(`off ${suffix}`, {
      availableOrganizationId: org,
    });
    const ids = async (organizationId: string | null) =>
      (
        await db.savedQueries.listAvailable({
          organizationId,
          excludeOwnerId: other,
          q: suffix,
          limit: 50,
        })
      ).rows.map((r) => r.id);
    expect(await ids(org)).toEqual([inOrg.id]);
    expect(await ids(null)).toEqual([noOrg.id]);
    expect(await ids(org)).not.toContain(off.id);
    expect(
      (
        await db.savedQueries.listAvailable({
          organizationId: org,
          excludeOwnerId: owner,
          limit: 50,
        })
      ).rows.map((r) => r.id)
    ).not.toContain(inOrg.id);
  });
});
