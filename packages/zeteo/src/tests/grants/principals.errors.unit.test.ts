// @module-tag unit
// @module-tag platform
import { REDIS_COMMAND_TIMEOUT_MS } from "../../utils/redisTimeout.js";
import { ServiceUnavailableError } from "../../utils/errors.js";
import { runInTransactionScope } from "../../utils/tereo.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Caller } from "../../middleware/auth.js";
import { RequestError } from "@tereo-io/sdk/handler";
import { requests } from "@tereo-io/sdk/handler";
import { logger } from "../../utils/logger.js";
import {
  fetchGroupsFromTereo,
  groupIdsOf,
  principalStatus,
  resolveGroupsWith,
  statusFromTereo,
} from "../../grants/principals.js";

const auth = vi.hoisted(() => ({
  listUserGroups: vi.fn(),
  getGroup: vi.fn(),
}));
vi.mock("../../utils/tereo.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/tereo.js")>()),
  getTereo: () => ({ auth }),
}));
// Commands of a client whose Redis is gone: the shared client queues them
// while it reconnects and never settles them.
const redis = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  sismember: vi.fn(),
}));
vi.mock("../../utils/redis.js", () => ({ redis }));
vi.mock("@tereo-io/sdk/handler", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tereo-io/sdk/handler")>()),
  requests: { auth: { getUser: vi.fn() } },
}));

// As the SDK's core client rejects: the RequestError with core's status, or
// without one when no answer came.
const failing = (status?: number) =>
  new RequestError("AS_0001", "request failed", { httpStatus: status });

afterEach(() => vi.resetAllMocks());

describe("fetchGroupsFromTereo", () => {
  it("returns id and organizationId of each group", async () => {
    auth.listUserGroups.mockResolvedValue([
      { id: "g", organizationId: "o", name: "x" },
    ]);
    expect(await fetchGroupsFromTereo("u")).toEqual([
      { id: "g", organizationId: "o" },
    ]);
  });

  it("reads null (core's 404) as no groups", async () => {
    auth.listUserGroups.mockResolvedValue(null);
    expect(await fetchGroupsFromTereo("u")).toEqual([]);
  });

  it("rethrows any other failure", async () => {
    auth.listUserGroups.mockRejectedValue(failing(500));
    await expect(fetchGroupsFromTereo("u")).rejects.toThrow("request failed");
  });
});

describe("statusFromTereo for a group", () => {
  it("is active when tereo has the group", async () => {
    auth.getGroup.mockResolvedValue({ id: "g" });
    expect(await statusFromTereo("group", "g")).toBe("active");
  });

  it("is orphaned on null (core's 404)", async () => {
    auth.getGroup.mockResolvedValue(null);
    expect(await statusFromTereo("group", "g")).toBe("orphaned");
  });

  // 403: a deploy whose service lacks group_resolver.
  it.each([403, 500, undefined])("is a 503 on %s", async (status) => {
    auth.getGroup.mockRejectedValue(failing(status));
    await expect(statusFromTereo("group", "g")).rejects.toBeInstanceOf(
      ServiceUnavailableError
    );
  });
});

describe("statusFromTereo for a user", () => {
  const getUser = () => vi.mocked(requests.auth.getUser);

  it("is active when tereo has the user", async () => {
    getUser().mockResolvedValue({} as never);
    expect(await statusFromTereo("user", "u")).toBe("active");
  });

  it("is orphaned on an HTTP 404 (the SDK's RequestError)", async () => {
    getUser().mockRejectedValue(
      new RequestError("AS_0001", "no user", { httpStatus: 404 })
    );
    expect(await statusFromTereo("user", "u")).toBe("orphaned");
  });

  it("is a 503 on any other failure", async () => {
    getUser().mockRejectedValue(
      new RequestError("AS_0001", "boom", { httpStatus: 500 })
    );
    await expect(statusFromTereo("user", "u")).rejects.toBeInstanceOf(
      ServiceUnavailableError
    );
  });
});

describe("transaction guard", () => {
  it("refuses both tereo calls inside a transaction", async () => {
    await runInTransactionScope(async () => {
      await expect(fetchGroupsFromTereo("u")).rejects.toThrow(
        /withAudit transaction/
      );
      await expect(statusFromTereo("user", "u")).rejects.toThrow(
        /withAudit transaction/
      );
      await expect(statusFromTereo("group", "g")).rejects.toThrow(
        /withAudit transaction/
      );
    });
  });
});

describe("Redis that never answers", () => {
  const never = () => new Promise<never>(() => undefined);
  // The bound, plus room for a slow runner.
  const WITHIN_MS = REDIS_COMMAND_TIMEOUT_MS + 1500;
  const caller: Caller = {
    userId: "u",
    organizationId: null,
    permissions: [],
    isServiceAccount: false,
  };

  const timed = async <T>(
    run: () => Promise<T>
  ): Promise<{ value?: T; error?: unknown; ms: number }> => {
    const started = Date.now();
    const result = await run().then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    );
    return { ...result, ms: Date.now() - started };
  };

  it("asks tereo when the group cache cannot be read, and returns without writing it", async () => {
    redis.get.mockImplementation(never);
    redis.set.mockImplementation(never);
    const warn = vi.spyOn(logger, "warn");
    const groups = [{ id: "g", organizationId: null }];
    const fetch = vi.fn().mockResolvedValue(groups);
    const { value, ms } = await timed(() => resolveGroupsWith(fetch, "u"));
    expect(value).toEqual(groups);
    expect(fetch).toHaveBeenCalledOnce();
    expect(ms).toBeLessThan(2 * WITHIN_MS);
    // One warning for the read and one for the write.
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("asks tereo when the group cache read fails outright", async () => {
    redis.get.mockRejectedValue(new Error("Connection is closed"));
    redis.set.mockResolvedValue("OK");
    const fetch = vi.fn().mockResolvedValue([]);
    expect(await resolveGroupsWith(fetch, "u")).toEqual([]);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("answers 503 for the test-mode group seam rather than waiting", async () => {
    redis.get.mockImplementation(never);
    const { error, ms } = await timed(() => groupIdsOf(caller));
    expect(error).toBeInstanceOf(ServiceUnavailableError);
    expect(ms).toBeLessThan(WITHIN_MS);
  });

  it("answers 503 for the test-mode group seam when Redis fails", async () => {
    redis.get.mockRejectedValue(new Error("Connection is closed"));
    await expect(groupIdsOf(caller)).rejects.toBeInstanceOf(
      ServiceUnavailableError
    );
  });

  it("answers 503 for the test-mode principalStatus seam rather than waiting", async () => {
    redis.sismember.mockImplementation(never);
    const { error, ms } = await timed(() => principalStatus("user", "u"));
    expect(error).toBeInstanceOf(ServiceUnavailableError);
    expect(ms).toBeLessThan(WITHIN_MS);
  });

  it("answers 503 for the test-mode principalStatus seam when Redis fails", async () => {
    redis.sismember.mockRejectedValue(new Error("Connection is closed"));
    await expect(principalStatus("group", "g")).rejects.toBeInstanceOf(
      ServiceUnavailableError
    );
  });
});
