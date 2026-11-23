// @module-tag unit
// @module-tag platform
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInTransactionScope } from "../../utils/tereo.js";
import { RequestError } from "@tereo-io/sdk/handler";
import {
  clearHierarchyCache,
  HierarchyTooLargeError,
  hierarchyCacheSize,
  HierarchyUnavailableError,
  HIERARCHY_TTL_SECONDS,
  usersBelowFromTereo as usersBelow,
} from "../../grants/hierarchy.js";

const auth = vi.hoisted(() => ({ listUserReports: vi.fn() }));
vi.mock("../../utils/tereo.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/tereo.js")>()),
  getTereo: () => ({ auth }),
}));

const failing = (status?: number) =>
  new RequestError("AS_0001", "request failed", { httpStatus: status });
const report = (id: string) => ({ id, depth: 1, reportsToId: "boss" });

beforeEach(() => {
  vi.useFakeTimers();
  clearHierarchyCache();
});
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe("usersBelow", () => {
  it("returns the ids of the transitive reports", async () => {
    auth.listUserReports.mockResolvedValue([report("a"), report("b")]);
    expect(await usersBelow("boss")).toEqual(["a", "b"]);
    expect(auth.listUserReports).toHaveBeenCalledWith("boss", {
      transitive: true,
    });
  });

  it("serves a second call within 30 s from the cache, then asks again", async () => {
    auth.listUserReports.mockResolvedValue([report("a")]);
    await usersBelow("boss");
    vi.advanceTimersByTime((HIERARCHY_TTL_SECONDS - 1) * 1000);
    await usersBelow("boss");
    expect(auth.listUserReports).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2000);
    await usersBelow("boss");
    expect(auth.listUserReports).toHaveBeenCalledTimes(2);
  });

  it("caches per user", async () => {
    auth.listUserReports.mockResolvedValue([]);
    await usersBelow("x");
    await usersBelow("y");
    expect(auth.listUserReports).toHaveBeenCalledTimes(2);
  });

  it("reads null as unavailable", async () => {
    auth.listUserReports.mockResolvedValue(null);
    await expect(usersBelow("boss")).rejects.toBeInstanceOf(
      HierarchyUnavailableError
    );
  });

  it("refuses to run inside a transaction", async () => {
    auth.listUserReports.mockResolvedValue([]);
    await expect(
      runInTransactionScope(() => usersBelow("boss"))
    ).rejects.toThrow();
    expect(auth.listUserReports).not.toHaveBeenCalled();
  });
});

describe("usersBelow errors", () => {
  it("maps a 422 to too large", async () => {
    auth.listUserReports.mockRejectedValue(failing(422));
    await expect(usersBelow("boss")).rejects.toBeInstanceOf(
      HierarchyTooLargeError
    );
  });

  it.each([503, 500, 403, undefined])(
    "maps %s to unavailable and does not cache it",
    async (status) => {
      auth.listUserReports.mockRejectedValueOnce(failing(status));
      await expect(usersBelow("boss")).rejects.toBeInstanceOf(
        HierarchyUnavailableError
      );
      auth.listUserReports.mockResolvedValueOnce([report("a")]);
      expect(await usersBelow("boss")).toEqual(["a"]);
    }
  );

  it("does not cache a too-large answer", async () => {
    auth.listUserReports.mockRejectedValueOnce(failing(422));
    await expect(usersBelow("boss")).rejects.toBeInstanceOf(
      HierarchyTooLargeError
    );
    auth.listUserReports.mockResolvedValueOnce([]);
    expect(await usersBelow("boss")).toEqual([]);
  });
});

describe("usersBelow cache eviction", () => {
  it("sweeps expired entries when a new answer is cached", async () => {
    auth.listUserReports.mockResolvedValue([report("a")]);
    await usersBelow("u1");
    await usersBelow("u2");
    expect(hierarchyCacheSize()).toBe(2);
    vi.advanceTimersByTime((HIERARCHY_TTL_SECONDS + 1) * 1000);
    await usersBelow("u3");
    expect(hierarchyCacheSize()).toBe(1);
    expect(auth.listUserReports).toHaveBeenCalledTimes(3);
  });

  it("keeps live entries and their 30 s semantics", async () => {
    auth.listUserReports.mockResolvedValue([report("a")]);
    await usersBelow("u1");
    vi.advanceTimersByTime(10_000);
    await usersBelow("u2");
    expect(hierarchyCacheSize()).toBe(2);
    await usersBelow("u1");
    expect(auth.listUserReports).toHaveBeenCalledTimes(2);
  });
});
