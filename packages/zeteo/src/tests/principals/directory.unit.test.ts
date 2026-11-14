// @module-tag unit
// @module-tag platform
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TereoUnreachableError } from "../../utils/errors.js";
import { runInTransactionScope } from "../../utils/tereo.js";
import { RequestError } from "@tereo-io/sdk/handler";
import { logger } from "../../utils/logger.js";
import {
  GROUP_CACHE_TTL_SECONDS,
  GROUP_READS_IN_FLIGHT,
  groupCacheKey,
  lookupFromTereo,
  MAX_USER_IDS_PER_REQUEST,
  searchFromTereo,
} from "../../principals/directory.js";

const A = "01a1d7a8-0000-7000-8000-00000000000a";
const B = "01a1d7a8-0000-7000-8000-00000000000b";
const MISSING = "01a1d7a8-0000-7000-8000-0000000000ff";
const G = "01a1d7a8-0000-7000-8000-0000000000a1";

const sdk = vi.hoisted(() => ({
  getUsersByIds: vi.fn(),
  listGroups: vi.fn(),
  handleRequest: vi.fn(),
  purgeServiceToken: vi.fn(),
}));
const auth = vi.hoisted(() => ({ getGroup: vi.fn() }));
vi.mock("../../utils/tereo.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/tereo.js")>()),
  getTereo: () => ({ auth }),
}));
// A Redis of one map; `down` makes every command fail.
const cache = vi.hoisted(() => ({
  store: new Map<string, string>(),
  ttl: new Map<string, number>(),
  down: false,
}));
vi.mock("../../utils/redis.js", () => ({
  redis: {
    mget: async (...keys: string[]) => {
      if (cache.down) throw new Error("redis down");
      return keys.map((k) => cache.store.get(k) ?? null);
    },
    set: async (key: string, value: string, _ex: "EX", seconds: number) => {
      if (cache.down) throw new Error("redis down");
      cache.store.set(key, value);
      cache.ttl.set(key, seconds);
      return "OK";
    },
  },
}));
vi.mock("@tereo-io/sdk/handler", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tereo-io/sdk/handler")>()),
  requests: {
    auth: { getUsersByIds: sdk.getUsersByIds, listGroups: sdk.listGroups },
  },
  getHandler: () => ({ handleRequest: sdk.handleRequest }),
  purgeServiceToken: sdk.purgeServiceToken,
}));

const user = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  email: `${id.slice(-1)}@example.com`,
  name: "Ada",
  isActive: true,
  userType: "human",
  status: "active",
  ...over,
});
const group = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: "Analysts",
  slug: "analysts",
  archivedAt: null,
  ...over,
});

// As the raw handler rejects: an axios error whose config holds the request's params.
const axiosError = (status: number | undefined, q = "ada") =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    config: { params: { "filter[name]": q, "filter[email]": q } },
    response: status === undefined ? undefined : { status },
  });
const page = (data: unknown[]) => ({ data: { data } });

beforeEach(() => {
  vi.spyOn(logger, "error").mockImplementation(() => undefined);
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  cache.store.clear();
  cache.ttl.clear();
  cache.down = false;
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe("lookupFromTereo", () => {
  it("returns the refs' order, with a missing user orphaned and the rest intact", async () => {
    sdk.getUsersByIds.mockResolvedValue([user(A)]);
    auth.getGroup.mockResolvedValue(group(G));
    const out = await lookupFromTereo([
      { type: "user", id: A },
      { type: "user", id: MISSING },
      { type: "group", id: G },
    ]);
    expect(out).toEqual([
      {
        type: "user",
        id: A,
        name: "Ada",
        email: "a@example.com",
        status: "active",
      },
      {
        type: "user",
        id: MISSING,
        name: null,
        email: null,
        status: "orphaned",
      },
      { type: "group", id: G, name: "Analysts", status: "active" },
    ]);
    expect("email" in out[2]!).toBe(false);
    expect(sdk.getUsersByIds).toHaveBeenCalledTimes(1);
    expect(sdk.getUsersByIds).toHaveBeenCalledWith([A, MISSING]);
  });

  it("asks for more than 100 users in batches of at most 100, in the refs' order", async () => {
    expect(MAX_USER_IDS_PER_REQUEST).toBe(100);
    const ids = Array.from(
      { length: MAX_USER_IDS_PER_REQUEST + 50 },
      (_, i) => `01a1d7a8-0000-7000-8000-${String(i).padStart(12, "0")}`
    );
    sdk.getUsersByIds.mockImplementation(async (batch: string[]) =>
      batch.map((id) => user(id))
    );
    const out = await lookupFromTereo(ids.map((id) => ({ type: "user", id })));
    expect(sdk.getUsersByIds.mock.calls.map(([b]) => b.length)).toEqual([
      MAX_USER_IDS_PER_REQUEST,
      50,
    ]);
    expect(out.map((p) => p.id)).toEqual(ids);
    expect(out.every((p) => p.status === "active")).toBe(true);
  });

  it("a batch element without an id or status is tereo_unreachable", async () => {
    for (const bad of [
      { email: "x@example.com", status: "active" },
      { id: A },
    ]) {
      sdk.getUsersByIds.mockResolvedValue([bad]);
      await expect(
        lookupFromTereo([{ type: "user", id: A }])
      ).rejects.toBeInstanceOf(TereoUnreachableError);
    }
  });

  it("collapses a repeated ref to its first", async () => {
    sdk.getUsersByIds.mockResolvedValue([user(A), user(B)]);
    const out = await lookupFromTereo([
      { type: "user", id: B },
      { type: "user", id: A },
      { type: "user", id: B },
    ]);
    expect(out.map((p) => p.id)).toEqual([B, A]);
  });

  it("is an orphan for a group tereo answers 404 for", async () => {
    auth.getGroup.mockResolvedValue(null);
    const [p] = await lookupFromTereo([{ type: "group", id: G }]);
    expect(p).toEqual({ type: "group", id: G, name: null, status: "orphaned" });
  });

  it("an inactive user and an archived group are inactive", async () => {
    sdk.getUsersByIds.mockResolvedValue([
      user(A, { isActive: false, status: "deactivated" }),
      user(B, { status: "expired" }),
    ]);
    auth.getGroup.mockResolvedValue(group(G, { archivedAt: "2026-01-01" }));
    const out = await lookupFromTereo([
      { type: "user", id: A },
      { type: "user", id: B },
      { type: "group", id: G },
    ]);
    expect(out.map((p) => p.status)).toEqual([
      "inactive",
      "inactive",
      "inactive",
    ]);
  });

  it("does not ask tereo about an id that is no UUID", async () => {
    const [p] = await lookupFromTereo([{ type: "user", id: "nope" }]);
    expect(p!.status).toBe("orphaned");
    expect(sdk.getUsersByIds).not.toHaveBeenCalled();
  });

  it("a failed batch is tereo_unreachable, not orphaned", async () => {
    sdk.getUsersByIds.mockRejectedValue(
      new RequestError("AS_0001", "down", { httpStatus: 503 })
    );
    await expect(
      lookupFromTereo([{ type: "user", id: A }])
    ).rejects.toBeInstanceOf(TereoUnreachableError);
  });

  it("a failed group read is tereo_unreachable", async () => {
    auth.getGroup.mockRejectedValue(
      new RequestError("AS_0001", "forbidden", { httpStatus: 403 })
    );
    await expect(
      lookupFromTereo([{ type: "group", id: G }])
    ).rejects.toMatchObject({ statusCode: 502, code: "tereo_unreachable" });
  });

  it("is refused inside a transaction", async () => {
    await runInTransactionScope(async () => {
      await expect(lookupFromTereo([{ type: "user", id: A }])).rejects.toThrow(
        /withAudit transaction/
      );
    });
  });
});

const groupIds = (n: number) =>
  Array.from(
    { length: n },
    (_, i) => `01a1d7a8-0000-7000-8000-${String(i).padStart(12, "0")}`
  );

describe("lookupFromTereo's group reads", () => {
  it("reads 100 groups never more than 8 at a time, in the refs' order", async () => {
    expect(GROUP_READS_IN_FLIGHT).toBe(8);
    let inFlight = 0;
    let most = 0;
    auth.getGroup.mockImplementation(async (id: string) => {
      most = Math.max(most, ++inFlight);
      await new Promise((r) => setImmediate(r));
      inFlight--;
      return group(id);
    });
    const ids = groupIds(100);
    const out = await lookupFromTereo(ids.map((id) => ({ type: "group", id })));
    expect(auth.getGroup).toHaveBeenCalledTimes(100);
    expect(most).toBe(GROUP_READS_IN_FLIGHT);
    expect(out.map((p) => p.id)).toEqual(ids);
  });

  it("asks tereo once for a group looked up again within the cache's 60 s", async () => {
    expect(GROUP_CACHE_TTL_SECONDS).toBe(60);
    auth.getGroup.mockResolvedValue(group(G));
    const first = await lookupFromTereo([{ type: "group", id: G }]);
    const second = await lookupFromTereo([{ type: "group", id: G }]);
    expect(second).toEqual(first);
    expect(auth.getGroup).toHaveBeenCalledTimes(1);
    expect(cache.ttl.get(groupCacheKey(G))).toBe(GROUP_CACHE_TTL_SECONDS);
    expect(groupCacheKey(G)).toBe(`zeteo:directory:group:${G}`);
  });

  it("caches an orphaned group as orphaned", async () => {
    auth.getGroup.mockResolvedValue(null);
    await lookupFromTereo([{ type: "group", id: G }]);
    const [p] = await lookupFromTereo([{ type: "group", id: G }]);
    expect(p).toEqual({ type: "group", id: G, name: null, status: "orphaned" });
    expect(auth.getGroup).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed read", async () => {
    auth.getGroup.mockRejectedValueOnce(
      new RequestError("AS_0001", "down", { httpStatus: 503 })
    );
    await expect(
      lookupFromTereo([{ type: "group", id: G }])
    ).rejects.toBeInstanceOf(TereoUnreachableError);
    expect(cache.store.size).toBe(0);
    auth.getGroup.mockResolvedValue(group(G));
    const [p] = await lookupFromTereo([{ type: "group", id: G }]);
    expect(p!.status).toBe("active");
    expect(auth.getGroup).toHaveBeenCalledTimes(2);
  });

  it("asks tereo when the cache fails, and only warns", async () => {
    cache.down = true;
    auth.getGroup.mockResolvedValue(group(G));
    const [p] = await lookupFromTereo([{ type: "group", id: G }]);
    expect(p).toEqual({
      type: "group",
      id: G,
      name: "Analysts",
      status: "active",
    });
    expect(logger.warn).toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("keeps users out of the cache", async () => {
    sdk.getUsersByIds.mockResolvedValue([user(A)]);
    await lookupFromTereo([{ type: "user", id: A }]);
    expect(cache.store.size).toBe(0);
  });
});

describe("searchFromTereo", () => {
  it("passes limit through, asks by name and by email, and maps users with email", async () => {
    sdk.handleRequest
      .mockResolvedValueOnce(page([user(A)]))
      .mockResolvedValueOnce(page([user(A), user(B)]));
    const out = await searchFromTereo("user", "ada", 2);
    expect(out).toEqual([
      {
        type: "user",
        id: A,
        name: "Ada",
        email: "a@example.com",
        status: "active",
      },
      {
        type: "user",
        id: B,
        name: "Ada",
        email: "b@example.com",
        status: "active",
      },
    ]);
    const params = sdk.handleRequest.mock.calls.map(([c]) => c.params);
    expect(params).toContainEqual({
      "filter[userType]": "human",
      limit: 2,
      "filter[name]": "ada",
      "filter[name_op]": "contains",
    });
    expect(params).toContainEqual({
      "filter[userType]": "human",
      limit: 2,
      "filter[email]": "ada",
      "filter[email_op]": "contains",
    });
    expect(sdk.handleRequest.mock.calls[0]![0]).toMatchObject({
      method: "GET",
      url: "/v1/admin/users",
    });
  });

  it("puts name matches first, de-duplicates by id and cuts to limit", async () => {
    sdk.handleRequest
      .mockResolvedValueOnce(page([user(B)]))
      .mockResolvedValueOnce(page([user(A), user(B)]));
    const out = await searchFromTereo("user", "x", 2);
    expect(out.map((p) => p.id)).toEqual([B, A]);
    sdk.handleRequest
      .mockResolvedValueOnce(page([user(B)]))
      .mockResolvedValueOnce(page([user(A)]));
    expect((await searchFromTereo("user", "x", 1)).map((p) => p.id)).toEqual([
      B,
    ]);
  });

  it("purges the service token and retries once on a 401", async () => {
    sdk.handleRequest
      .mockRejectedValueOnce(axiosError(401))
      .mockResolvedValue(page([user(A)]));
    const out = await searchFromTereo("user", "ada", 5);
    expect(out.map((p) => p.id)).toEqual([A]);
    expect(sdk.purgeServiceToken).toHaveBeenCalled();
  });

  it("gives up after a second 401", async () => {
    sdk.handleRequest.mockRejectedValue(axiosError(401));
    await expect(searchFromTereo("user", "ada", 5)).rejects.toBeInstanceOf(
      TereoUnreachableError
    );
  });

  it("searches groups with q and limit, mapping them without email", async () => {
    sdk.listGroups.mockResolvedValue({ data: [group(G)] });
    const out = await searchFromTereo("group", "analy", 7);
    expect(sdk.listGroups).toHaveBeenCalledWith({ q: "analy", limit: 7 });
    expect(out).toEqual([
      { type: "group", id: G, name: "Analysts", status: "active" },
    ]);
    expect("email" in out[0]!).toBe(false);
  });

  it("nothing of q, a name or an email is logged on failure", async () => {
    sdk.handleRequest.mockRejectedValue(axiosError(500, "ada@example.com"));
    await expect(
      searchFromTereo("user", "ada@example.com", 5)
    ).rejects.toBeInstanceOf(TereoUnreachableError);
    sdk.getUsersByIds.mockRejectedValue(axiosError(503));
    await expect(
      lookupFromTereo([{ type: "user", id: A }])
    ).rejects.toBeInstanceOf(TereoUnreachableError);
    const logged = vi.mocked(logger.error).mock.calls.map(([obj]) => {
      const { err, ...rest } = obj as { err: Error };
      return JSON.stringify({
        ...rest,
        err: { ...err, message: err.message, stack: err.stack },
      });
    });
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) {
      expect(line).not.toContain("ada");
      expect(line).not.toContain("example.com");
    }
  });

  it("is refused inside a transaction", async () => {
    await runInTransactionScope(async () => {
      await expect(searchFromTereo("user", "a", 1)).rejects.toThrow(
        /withAudit transaction/
      );
    });
  });
});
