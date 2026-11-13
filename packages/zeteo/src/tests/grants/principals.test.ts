// @module-tag int
// @module-tag platform
import { ServiceUnavailableError } from "../../utils/errors.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Caller } from "../../middleware/auth.js";
import { redis } from "../../utils/redis.js";
import { randomUUID } from "crypto";
import {
  groupIdsOf,
  principalStatus,
  resolveGroupsWith,
} from "../../grants/principals.js";
import {
  clearOrphaned,
  clearTestGroups,
  markOrphaned,
  setTestGroups,
} from "../support/principals.js";

const caller = (over: Partial<Caller> = {}): Caller => ({
  userId: randomUUID(),
  organizationId: null,
  permissions: [],
  isServiceAccount: false,
  ...over,
});

describe("groupIdsOf", () => {
  const users: string[] = [];
  afterEach(async () => {
    for (const u of users.splice(0)) await clearTestGroups(u);
  });

  it("reads the test-mode list from Redis, none when absent", async () => {
    const c = caller();
    users.push(c.userId);
    expect(await groupIdsOf(c)).toEqual([]);
    await setTestGroups(c.userId, [{ id: "g1", organizationId: null }]);
    expect(await groupIdsOf(c)).toEqual(["g1"]);
  });

  it("counts global groups and the token's organization's, not another's", async () => {
    const c = caller({ organizationId: "org-a" });
    users.push(c.userId);
    await setTestGroups(c.userId, [
      { id: "global", organizationId: null },
      { id: "mine", organizationId: "org-a" },
      { id: "theirs", organizationId: "org-b" },
    ]);
    expect(await groupIdsOf(c)).toEqual(["global", "mine"]);
  });

  it("counts only global groups for a token without an organization", async () => {
    const c = caller();
    users.push(c.userId);
    await setTestGroups(c.userId, [
      { id: "global", organizationId: null },
      { id: "theirs", organizationId: "org-b" },
    ]);
    expect(await groupIdsOf(c)).toEqual(["global"]);
  });

  it("gives a service account no groups", async () => {
    const c = caller({ isServiceAccount: true });
    users.push(c.userId);
    await setTestGroups(c.userId, [{ id: "g1", organizationId: null }]);
    expect(await groupIdsOf(c)).toEqual([]);
  });
});

describe("resolveGroupsWith", () => {
  const key = (userId: string) => `zeteo:groups:${userId}`;

  it("caches the unfiltered list for 30 s, and asks again after it expires", async () => {
    const userId = randomUUID();
    const groups = [
      { id: "g1", organizationId: null },
      { id: "g2", organizationId: "org-b" },
    ];
    const fetch = vi.fn().mockResolvedValue(groups);
    expect(await resolveGroupsWith(fetch, userId)).toEqual(groups);
    expect(await resolveGroupsWith(fetch, userId)).toEqual(groups);
    expect(fetch).toHaveBeenCalledTimes(1);
    const ttl = await redis.ttl(key(userId));
    expect(ttl).toBeGreaterThan(25);
    expect(ttl).toBeLessThanOrEqual(30);

    await redis.pexpire(key(userId), 1);
    await new Promise((r) => setTimeout(r, 20));
    await resolveGroupsWith(fetch, userId);
    expect(fetch).toHaveBeenCalledTimes(2);
    await redis.del(key(userId));
  });

  it("answers 503 when the fetch fails, never an empty list, and caches nothing", async () => {
    const userId = randomUUID();
    const fetch = vi.fn().mockRejectedValue(new Error("tereo is down"));
    await expect(resolveGroupsWith(fetch, userId)).rejects.toBeInstanceOf(
      ServiceUnavailableError
    );
    expect(await redis.exists(key(userId))).toBe(0);
  });
});

describe("principalStatus", () => {
  it("is orphaned only for ids marked so in test mode", async () => {
    const id = randomUUID();
    expect(await principalStatus("user", id)).toBe("active");
    await markOrphaned(id);
    expect(await principalStatus("user", id)).toBe("orphaned");
    await clearOrphaned(id);
    expect(await principalStatus("group", id)).toBe("active");
  });
});
