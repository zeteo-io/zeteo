// @module-tag int
// @module-tag platform
import { removeDashboardsOf } from "../../../../../support/panelDecisions.js";
import { userWithOrders } from "../../../../../support/savedQueries.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeSources } from "../../../../../support/sources.js";
import { tokenFor } from "../../../../../support/tokens.js";
import { ENGINES } from "../../../../../support/engines.js";
import { randomUUID } from "crypto";
import {
  DASHBOARDS_READ,
  DASHBOARDS_WRITE,
  DATA_READ,
} from "../../../../../../definitions/tereoDeclaration.js";
import {
  dashboardOf,
  dashboardsCall,
  shareDashboardDirectly,
} from "../../../../../support/dashboards.js";
import {
  addToDirectory,
  clearDirectory,
  clearTestGroups,
  setTestGroups,
} from "../../../../../support/principals.js";
import {
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../../../../../support/queries.js";

const OTHER_ORG_MESSAGE =
  "Groups can only be shared with in your signed-in organization";

describe("/v1/dashboards/:dashboardId/shares", () => {
  let source: SeededSource;
  const users: string[] = [];
  const members: string[] = [];
  const user = async () => {
    const u = await userWithOrders(source, "all");
    users.push(u.id);
    return u;
  };
  const group = async (org: string | null) => {
    const id = randomUUID();
    await addToDirectory([
      {
        type: "group",
        id,
        name: `Group ${id.slice(0, 6)}`,
        status: "active",
        organization_id: org,
      },
    ]);
    return id;
  };
  const put = (id: string, token: string, principals: unknown[]) =>
    dashboardsCall("PUT", `/${id}/shares`, token, { principals });

  beforeAll(async () => {
    source = await seedQuerySource(ENGINES[0]!, {}, "dashshares");
  });
  afterAll(async () => {
    for (const m of members) await clearTestGroups(m);
    await clearDirectory();
    await removeDashboardsOf(users);
    await removeRunsOf(users);
    await removeSources([source.id]);
  });

  it("shares with a user, answers the list with no warnings, and lets them read it", async () => {
    const owner = await user();
    const recipient = await user();
    await addToDirectory([
      {
        type: "user",
        id: recipient.id,
        name: "Rita",
        email: "rita@example.com",
        status: "active",
      },
    ]);
    const id = await dashboardOf(owner.token);
    const res = await put(id, owner.token, [recipient.principal]);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: [
        {
          type: "user",
          id: recipient.id,
          name: "Rita",
          email: "rita@example.com",
          shared_at: expect.any(String),
        },
      ],
    });
    const listed = await dashboardsCall("GET", `/${id}/shares`, owner.token);
    expect(listed.body).toEqual({ data: res.body.data });
    expect(
      (await dashboardsCall("GET", `/${id}`, recipient.token)).status
    ).toBe(200);
    // Nothing for a recipient to list.
    expect(
      (await dashboardsCall("GET", `/${id}/shares`, recipient.token)).status
    ).toBe(404);
  });

  it("shares with a group, which reaches its members", async () => {
    const owner = await user();
    const member = await user();
    const g = await group(null);
    members.push(member.id);
    await setTestGroups(member.id, [{ id: g, organizationId: null }]);
    const id = await dashboardOf(owner.token);
    expect(
      (await put(id, owner.token, [{ type: "group", id: g }])).status
    ).toBe(200);
    expect((await dashboardsCall("GET", `/${id}`, member.token)).status).toBe(
      200
    );
    const shared = await dashboardsCall("GET", "?scope=shared", member.token);
    expect(shared.body.data.map((d: { id: string }) => d.id)).toEqual([id]);
  });

  it("refuses a group of another organization, with the message, and changes nothing", async () => {
    const owner = await user();
    const id = await dashboardOf(owner.token);
    const org = randomUUID();
    const mine = tokenFor({
      userId: owner.id,
      permissions: [DATA_READ],
      org,
    });
    const foreign = await group(randomUUID());
    const local = await group(org);
    const bad = await put(id, mine, [{ type: "group", id: foreign }]);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid_share");
    expect(bad.body.error_description).toBe(OTHER_ORG_MESSAGE);
    // Signed in to no organization, only a global group is allowed.
    const orgOnly = await put(id, owner.token, [{ type: "group", id: local }]);
    expect(orgOnly.status).toBe(400);
    expect(orgOnly.body.error).toBe("invalid_share");
    expect((await put(id, mine, [{ type: "group", id: local }])).status).toBe(
      200
    );
    const listed = await dashboardsCall("GET", `/${id}/shares`, owner.token);
    expect(listed.body.data.map((s: { id: string }) => s.id)).toEqual([local]);
  });

  it("refuses the owner as a recipient, and a group that does not exist", async () => {
    const owner = await user();
    const id = await dashboardOf(owner.token);
    const self = await put(id, owner.token, [owner.principal]);
    expect(self.status).toBe(400);
    expect(self.body.error).toBe("invalid_share");
    const ghost = await put(id, owner.token, [
      { type: "group", id: randomUUID() },
    ]);
    expect(ghost.status).toBe(400);
    expect(ghost.body.error).toBe("invalid_share");
  });

  it("replaces the whole list, so a removed recipient loses access", async () => {
    const owner = await user();
    const a = await user();
    const b = await user();
    const id = await dashboardOf(owner.token);
    await put(id, owner.token, [a.principal, b.principal]);
    const res = await put(id, owner.token, [b.principal]);
    expect(res.body.data.map((s: { id: string }) => s.id)).toEqual([b.id]);
    expect((await dashboardsCall("GET", `/${id}`, a.token)).status).toBe(404);
    expect((await dashboardsCall("GET", `/${id}`, b.token)).status).toBe(200);
  });

  it("is a 404 to a stranger and a recipient; readers may list, writers may replace", async () => {
    const owner = await user();
    const recipient = await user();
    const stranger = await user();
    const id = await dashboardOf(owner.token);
    await shareDashboardDirectly(id, recipient.principal, owner.id);
    for (const who of [recipient, stranger]) {
      expect(
        (await dashboardsCall("GET", `/${id}/shares`, who.token)).status
      ).toBe(404);
      expect((await put(id, who.token, [])).status).toBe(404);
    }
    const reader = tokenFor({ permissions: [DATA_READ, DASHBOARDS_READ] });
    expect((await dashboardsCall("GET", `/${id}/shares`, reader)).status).toBe(
      200
    );
    expect((await put(id, reader, [])).status).toBe(403);
    const writer = tokenFor({ permissions: [DATA_READ, DASHBOARDS_WRITE] });
    expect((await put(id, writer, [])).status).toBe(200);
    expect(
      (await dashboardsCall("GET", `/${id}`, recipient.token)).status
    ).toBe(404);
  });
});
