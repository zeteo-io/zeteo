import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { tereoLogEntries } from "../support/compose.js";
import { requestJson, sleep } from "../support/http.js";
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

// What the admin UI and the SDK read through zeteo: the same directory, behind
// zeteo's permissions.
describe("zeteo's principals endpoints", () => {
  const zeteo = (path: string, token: string, body?: unknown) =>
    requestJson(
      body === undefined ? "GET" : "POST",
      `${stack.zeteoUrl}${path}`,
      {
        token,
        body,
      }
    );
  const search = (token: string, type: string, q: string) =>
    zeteo(
      `/v1/principals?${new URLSearchParams({ type, q, limit: "25" })}`,
      token
    );
  const lookup = (
    token: string,
    principals: Array<{ type: string; id: string }>
  ) => zeteo("/v1/principals/lookup", token, { principals });

  it("the admin finds alice by a fragment of her email, active", async () => {
    const res = await search(e2e.admin.zeteoToken, "user", "ice@e2e.ex");

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.body.data).toContainEqual({
      type: "user",
      id: e2e.alice.id,
      name: "alice",
      email: e2e.alice.email,
      status: "active",
    });
    expect(
      (res.body.data as Array<{ id: string }>).map((p) => p.id)
    ).not.toContain(e2e.bob.id);
  });

  it("the admin finds the e2e group by name", async () => {
    const res = await search(e2e.admin.zeteoToken, "group", "ANALYST");

    expect(res.status).toBe(200);
    expect(res.body.data).toContainEqual({
      type: "group",
      id: e2e.groupId,
      name: "e2e-analysts",
      status: "active",
    });
  });

  it("lookup names alice and the group and marks an unknown user orphaned", async () => {
    const missing = randomUUID();
    const started = new Date().toISOString();

    const res = await lookup(e2e.admin.zeteoToken, [
      { type: "user", id: e2e.alice.id },
      { type: "group", id: e2e.groupId },
      { type: "user", id: missing },
    ]);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      {
        type: "user",
        id: e2e.alice.id,
        name: "alice",
        email: e2e.alice.email,
        status: "active",
      },
      {
        type: "group",
        id: e2e.groupId,
        name: "e2e-analysts",
        status: "active",
      },
      {
        type: "user",
        id: missing,
        name: null,
        email: null,
        status: "orphaned",
      },
    ]);
    // Neither a 4xx nor a refusal of zeteo's service account in Tereo's log.
    await refusalsAbsent(started);
  });

  it("a person without zeteo.grants.read is refused search, and lookup", async () => {
    const searched = await search(e2e.bob.token, "user", "alice");
    expect(searched.status).toBe(403);

    const looked = await lookup(e2e.bob.token, [
      { type: "user", id: e2e.alice.id },
    ]);
    expect(looked.status).toBe(403);
  });

  it("search finds only people; a service account is found by id through lookup", async () => {
    const token = await serviceToken(
      stack.app.clientId,
      stack.app.clientSecret
    );
    const me = await requestJson("GET", `${stack.tereoUrl}/v1/account/me`, {
      token,
    });
    const serviceUserId = (me.body.id ?? me.body.user?.id) as string;

    const looked = await lookup(e2e.admin.zeteoToken, [
      { type: "user", id: serviceUserId },
    ]);
    expect(looked.status).toBe(200);
    const [found] = looked.body.data as Array<{
      id: string;
      name: string | null;
      email: string | null;
      status: string;
    }>;
    expect(found).toMatchObject({ id: serviceUserId, status: "active" });

    // Search by what the service account is called: it is not a person.
    const fragment = (found.name ?? found.email ?? "e2e-app").slice(0, 6);
    const searched = await search(e2e.admin.zeteoToken, "user", fragment);
    expect(searched.status).toBe(200);
    expect(
      (searched.body.data as Array<{ id: string }>).map((p) => p.id)
    ).not.toContain(serviceUserId);
  });

  it("an out-of-range search is 400", async () => {
    expect((await search(e2e.admin.zeteoToken, "user", "a")).status).toBe(400);
    const limit = await zeteo(
      `/v1/principals?${new URLSearchParams({ type: "user", q: "alice", limit: "26" })}`,
      e2e.admin.zeteoToken
    );
    expect(limit.status).toBe(400);
  });
});

/**
 * Tereo logs the requests it refuses: for the directory's two admin
 * endpoints, none since `since`.
 */
const refusalsAbsent = async (since: string) => {
  // A log line may reach `docker compose logs` a moment after the response.
  await sleep(1500);
  const refused = tereoLogEntries(since).filter(
    (entry) =>
      /path: "\/v1\/admin\/(users|groups)/.test(entry) &&
      /status: [45]\d\d/.test(entry)
  );
  expect(refused).toEqual([]);
};
