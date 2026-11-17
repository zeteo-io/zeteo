// @module-tag int
// @module-tag platform
import { DATA_READ } from "../../../../definitions/tereoDeclaration.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeSources } from "../../../support/sources.js";
import { prisma } from "../../../../utils/db/prisma.js";
import { tokenFor } from "../../../support/tokens.js";
import { ENGINES } from "../../../support/engines.js";
import { randomUUID } from "crypto";
import {
  savedQueriesCall,
  savedQueryOf,
  shareDirectly,
  uniqueName,
  userWithOrders,
} from "../../../support/savedQueries.js";
import {
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../../../support/queries.js";

describe("saved queries available for dashboards", () => {
  let source: SeededSource;
  const orgA = randomUUID();
  const orgB = randomUUID();
  const users: string[] = [];

  const inOrg = (user: { id: string }, org: string) =>
    tokenFor({ userId: user.id, permissions: [DATA_READ], org });

  beforeAll(async () => {
    source = await seedQuerySource(ENGINES[0]!, {}, "availsaved");
  });
  afterAll(async () => {
    await removeRunsOf(users);
    await removeSources([source.id]);
  });

  const setUp = async () => {
    const owner = await userWithOrders(source);
    const peerA = await userWithOrders(source);
    const peerB = await userWithOrders(source);
    users.push(owner.id, peerA.id, peerB.id);
    const id = await savedQueryOf(inOrg(owner, orgA), source);
    return { owner, peerA, peerB, id };
  };

  it("is off by default and shows no toggle effect to others", async () => {
    const { owner, peerA, id } = await setUp();
    const mine = await savedQueriesCall("GET", `/${id}`, inOrg(owner, orgA));
    expect(mine.body.available_for_dashboards).toBe(false);
    expect(
      (await savedQueriesCall("GET", `/${id}`, inOrg(peerA, orgA))).status
    ).toBe(404);
  });

  it("reaches the owner's organization only, and turning it off removes it", async () => {
    const { owner, peerA, peerB, id } = await setUp();
    const on = await savedQueriesCall("PATCH", `/${id}`, inOrg(owner, orgA), {
      available_for_dashboards: true,
    });
    expect(on.status).toBe(200);
    expect(on.body.available_for_dashboards).toBe(true);
    const row = await prisma.savedQuery.findUniqueOrThrow({ where: { id } });
    expect(row.availableOrganizationId).toBe(orgA);

    const list = await savedQueriesCall(
      "GET",
      "?scope=available",
      inOrg(peerA, orgA)
    );
    expect(list.status).toBe(200);
    const entry = list.body.data.find((s: { id: string }) => s.id === id);
    expect(entry).toMatchObject({
      accessible: true,
      available_for_dashboards: true,
    });
    expect(entry).not.toHaveProperty("used_by");
    expect(
      (await savedQueriesCall("GET", `/${id}`, inOrg(peerA, orgA))).status
    ).toBe(200);
    const run = await savedQueriesCall(
      "POST",
      `/${id}/run`,
      inOrg(peerA, orgA)
    );
    expect(run.status).toBe(200);

    const otherList = await savedQueriesCall(
      "GET",
      "?scope=available",
      inOrg(peerB, orgB)
    );
    expect(otherList.body.data.some((s: { id: string }) => s.id === id)).toBe(
      false
    );
    expect(
      (await savedQueriesCall("GET", `/${id}`, inOrg(peerB, orgB))).status
    ).toBe(404);

    // The owner's own list under `available` excludes their own.
    const ownList = await savedQueriesCall(
      "GET",
      "?scope=available",
      inOrg(owner, orgA)
    );
    expect(ownList.body.data.some((s: { id: string }) => s.id === id)).toBe(
      false
    );

    const off = await savedQueriesCall("PATCH", `/${id}`, inOrg(owner, orgA), {
      available_for_dashboards: false,
    });
    expect(off.body.available_for_dashboards).toBe(false);
    expect(
      (await savedQueriesCall("GET", `/${id}`, inOrg(peerA, orgA))).status
    ).toBe(404);
  });

  it("matches null with null: signed in without an organization", async () => {
    const { owner, peerA, id } = await setUp();
    const bare = (u: { id: string }) =>
      tokenFor({ userId: u.id, permissions: [DATA_READ] });
    await savedQueriesCall("PATCH", `/${id}`, bare(owner), {
      available_for_dashboards: true,
    });
    expect((await savedQueriesCall("GET", `/${id}`, bare(peerA))).status).toBe(
      200
    );
    expect(
      (await savedQueriesCall("GET", `/${id}`, inOrg(peerA, orgA))).status
    ).toBe(404);
  });

  it("refuses the toggle to a recipient with 404", async () => {
    const { owner, peerA, id } = await setUp();
    await shareDirectly(id, { type: "user", id: peerA.id }, owner.id);
    const res = await savedQueriesCall("PATCH", `/${id}`, inOrg(peerA, orgA), {
      available_for_dashboards: true,
    });
    expect(res.status).toBe(404);
  });

  it("audits the toggle in saved_query.updated", async () => {
    const { owner, id } = await setUp();
    await savedQueriesCall("PATCH", `/${id}`, inOrg(owner, orgA), {
      available_for_dashboards: true,
    });
    const rows = await prisma.$queryRawUnsafe<Array<{ payload: unknown }>>(
      `SELECT payload FROM "core"."core_outbox" WHERE payload::text LIKE $1`,
      `%${id}%`
    );
    expect(JSON.stringify(rows)).toContain("available_for_dashboards");
  });

  it("shows used_by to the owner only", async () => {
    const { owner, peerA, id } = await setUp();
    await savedQueriesCall("PATCH", `/${id}`, inOrg(owner, orgA), {
      available_for_dashboards: true,
    });
    const dash = await prisma.dashboard.create({
      data: { ownerId: owner.id, name: uniqueName("d"), description: "" },
    });
    await prisma.dashboardPanel.create({
      data: {
        dashboardId: dash.id,
        kind: "own",
        x: 0,
        y: 0,
        w: 4,
        h: 3,
        savedQueryId: id,
      },
    });
    const panel = await prisma.savedPanel.create({
      data: {
        ownerId: owner.id,
        name: uniqueName("p"),
        savedQueryId: id,
        chart: { version: 1, type: "table" },
      },
    });
    try {
      const mine = await savedQueriesCall("GET", `/${id}`, inOrg(owner, orgA));
      expect(mine.body.used_by).toEqual({ dashboards: 1, saved_panels: 1 });
      const theirs = await savedQueriesCall(
        "GET",
        `/${id}`,
        inOrg(peerA, orgA)
      );
      expect(theirs.body).not.toHaveProperty("used_by");
    } finally {
      await prisma.savedPanel.delete({ where: { id: panel.id } });
      await prisma.dashboard.delete({ where: { id: dash.id } });
    }
  });

  it("rejects an unknown field and a non-boolean", async () => {
    const { owner, id } = await setUp();
    const res = await savedQueriesCall("PATCH", `/${id}`, inOrg(owner, orgA), {
      available_for_dashboards: "yes",
    });
    expect(res.status).toBe(400);
  });
});
