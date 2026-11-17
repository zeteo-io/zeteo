// @module-tag int
// @module-tag platform
import { DATA_READ } from "../../../../../../definitions/tereoDeclaration.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeSources } from "../../../../../support/sources.js";
import { tokenFor } from "../../../../../support/tokens.js";
import { ENGINES } from "../../../../../support/engines.js";
import { randomUUID } from "crypto";
import {
  savedQueriesCall,
  savedQueryOf,
  userWithOrders,
} from "../../../../../support/savedQueries.js";
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

describe("/v1/saved-queries/:savedQueryId/shares", () => {
  let source: SeededSource;
  const users: string[] = [];
  const members: string[] = [];
  const user = async (columns: string[] | "all" = ["id", "status"]) => {
    const u = await userWithOrders(source, columns);
    users.push(u.id);
    return u;
  };
  /** A group in the directory, of `org` or global (null). */
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
    savedQueriesCall("PUT", `/${id}/shares`, token, { principals });

  beforeAll(async () => {
    source = await seedQuerySource(ENGINES[0]!, {}, "savedshares");
  });
  afterAll(async () => {
    for (const m of members) await clearTestGroups(m);
    await clearDirectory();
    await removeRunsOf(users);
    await removeSources([source.id]);
  });

  it("shares with a user who can run it, with no warning, and lists the share", async () => {
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
    const id = await savedQueryOf(owner.token, source);
    const res = await put(id, owner.token, [recipient.principal]);
    expect(res.status).toBe(200);
    expect(res.body.warnings).toEqual([]);
    expect(res.body.data).toEqual([
      {
        type: "user",
        id: recipient.id,
        name: "Rita",
        email: "rita@example.com",
        shared_at: expect.any(String),
      },
    ]);
    const listed = await savedQueriesCall("GET", `/${id}/shares`, owner.token);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({ data: res.body.data });
    const seen = await savedQueriesCall("GET", `/${id}`, recipient.token);
    expect(seen.status).toBe(200);
    expect(seen.body.accessible).toBe(true);
  });

  it("warns of each newly added user who cannot run it, and only them", async () => {
    const owner = await user();
    const able = await user();
    const unable = await user(["id"]);
    const id = await savedQueryOf(owner.token, source);
    const res = await put(id, owner.token, [able.principal, unable.principal]);
    expect(res.status).toBe(200);
    expect(res.body.warnings).toEqual([
      { type: "user", id: unable.id, accessible: false },
    ]);
    // Not new any more: no warning.
    const again = await put(id, owner.token, [
      able.principal,
      unable.principal,
    ]);
    expect(again.body.warnings).toEqual([]);
  });

  it("gives a group no warning and a group item no email", async () => {
    const owner = await user();
    const g = await group(null);
    const id = await savedQueryOf(owner.token, source);
    const res = await put(id, owner.token, [{ type: "group", id: g }]);
    expect(res.status).toBe(200);
    expect(res.body.warnings).toEqual([]);
    expect(res.body.data).toEqual([
      {
        type: "group",
        id: g,
        name: `Group ${g.slice(0, 6)}`,
        shared_at: expect.any(String),
      },
    ]);
  });

  it("shows a group share only to a member signed in to the group's organization", async () => {
    const orgA = randomUUID();
    const orgB = randomUUID();
    const owner = await user();
    const ownerInA = tokenFor({
      userId: owner.id,
      org: orgA,
      permissions: [DATA_READ],
    });
    const g = await group(orgA);
    const member = await user();
    members.push(member.id);
    await setTestGroups(member.id, [{ id: g, organizationId: orgA }]);
    const id = await savedQueryOf(owner.token, source);
    expect((await put(id, ownerInA, [{ type: "group", id: g }])).status).toBe(
      200
    );

    const inA = tokenFor({
      userId: member.id,
      org: orgA,
      permissions: [DATA_READ],
    });
    const inB = tokenFor({
      userId: member.id,
      org: orgB,
      permissions: [DATA_READ],
    });
    const sharedInA = await savedQueriesCall("GET", "?scope=shared", inA);
    expect(sharedInA.body.data.map((s: { id: string }) => s.id)).toEqual([id]);
    expect((await savedQueriesCall("GET", `/${id}`, inA)).status).toBe(200);

    const sharedInB = await savedQueriesCall("GET", "?scope=shared", inB);
    expect(sharedInB.body.data).toEqual([]);
    expect((await savedQueriesCall("GET", `/${id}`, inB)).status).toBe(404);
  });

  it("refuses a group of another organization, or one the directory does not have", async () => {
    const orgA = randomUUID();
    const owner = await user();
    const ownerInA = tokenFor({
      userId: owner.id,
      org: orgA,
      permissions: [DATA_READ],
    });
    const theirs = await group(randomUUID());
    const unknown = randomUUID();
    const id = await savedQueryOf(owner.token, source);
    for (const [token, g] of [
      [ownerInA, theirs],
      [ownerInA, unknown],
      // Signed in to no organization: only global groups.
      [owner.token, await group(orgA)],
    ] as const) {
      const res = await put(id, token, [{ type: "group", id: g }]);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        error: "invalid_share",
        error_description: OTHER_ORG_MESSAGE,
      });
    }
    const listed = await savedQueriesCall("GET", `/${id}/shares`, owner.token);
    expect(listed.body.data).toEqual([]);
  });

  it("replaces the list: a removed recipient no longer finds it", async () => {
    const owner = await user();
    const kept = await user();
    const dropped = await user();
    const id = await savedQueryOf(owner.token, source);
    await put(id, owner.token, [kept.principal, dropped.principal]);
    expect(
      (await savedQueriesCall("GET", `/${id}`, dropped.token)).status
    ).toBe(200);
    const res = await put(id, owner.token, [kept.principal]);
    expect(res.status).toBe(200);
    expect(res.body.data.map((s: { id: string }) => s.id)).toEqual([kept.id]);
    expect(
      (await savedQueriesCall("GET", `/${id}`, dropped.token)).status
    ).toBe(404);
    expect((await savedQueriesCall("GET", `/${id}`, kept.token)).status).toBe(
      200
    );
    const cleared = await put(id, owner.token, []);
    expect(cleared.body).toEqual({ data: [], warnings: [] });
  });

  it("refuses the owner as a recipient", async () => {
    const owner = await user();
    const id = await savedQueryOf(owner.token, source);
    const res = await put(id, owner.token, [owner.principal]);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_share");
  });

  it("refuses a repeated principal", async () => {
    const owner = await user();
    const other = await user();
    const id = await savedQueryOf(owner.token, source);
    const res = await put(id, owner.token, [other.principal, other.principal]);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("is a 404 for a saved query that does not exist", async () => {
    const owner = await user();
    const res = await put(randomUUID(), owner.token, []);
    expect(res.status).toBe(404);
  });
});
