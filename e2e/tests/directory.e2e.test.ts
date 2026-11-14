import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { serviceToken } from "../support/oauth.js";
import { stack } from "../support/stack.js";
import {
  createGroup,
  searchGroups,
  searchUsers,
  usersByIds,
  type DirectoryUser,
} from "../support/tereo.js";

const e2e = inject("e2e");

// What zeteo's admin UI will look people and groups up with: Tereo's admin
// API, called with zeteo's own service token (its user_resolver and
// group_resolver roles), not the admin's.
describe("Tereo's directory as zeteo's service account reads it", () => {
  let token: string;

  beforeAll(async () => {
    token = await serviceToken(stack.zeteo.clientId, stack.zeteo.clientSecret);
  });

  it("zeteo's service account can search users by name and by email", async () => {
    // alice's name is "alice", her email alice@e2e.example.com.
    const byName = await searchUsers(token, "name", "LIC");
    const byEmail = await searchUsers(token, "email", "ice@e2e.ex");

    for (const res of [byName, byEmail]) {
      expect(res.status).toBe(200);
      const found = (res.body.data as DirectoryUser[]).find(
        (u) => u.id === e2e.alice.id
      );
      expect(found).toMatchObject({
        email: e2e.alice.email,
        name: "alice",
        isActive: true,
        status: "active",
      });
    }
    // bob matches neither fragment: the filters are applied, not ignored.
    for (const res of [byName, byEmail]) {
      expect((res.body.data as DirectoryUser[]).map((u) => u.id)).not.toContain(
        e2e.bob.id
      );
    }
  });

  it("zeteo's service account can search groups by name", async () => {
    // A second group the query must leave out, so an ignored `q` would show.
    const otherId = await createGroup(
      e2e.admin.coreToken,
      `e2e-ops-${randomUUID().slice(0, 8)}`
    );

    const res = await searchGroups(token, "ANALYST");

    expect(res.status).toBe(200);
    const ids = (res.body.data as Array<{ id: string }>).map((g) => g.id);
    expect(ids).toContain(e2e.groupId);
    expect(ids).not.toContain(otherId);

    const none = await searchGroups(token, "no-such-group");
    expect(none.status).toBe(200);
    expect(none.body.data).toEqual([]);
  });

  it("users are read by id in one request, missing ids left out", async () => {
    const res = await usersByIds(token, [e2e.alice.id, randomUUID()]);

    expect(res.status).toBe(200);
    expect((res.body.data as DirectoryUser[]).map((u) => u.id)).toEqual([
      e2e.alice.id,
    ]);
  });
});
