// @module-tag unit
// @module-tag platform
import { NAME_LOOKUP_DEADLINE_MS } from "../../routes/v1/me/controllers.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TereoUnreachableError } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";
import {
  DIRECTORY_BUDGET_MS,
  lookupFromTereo,
  searchFromTereo,
} from "../../principals/directory.js";

const A = "01a1d7a8-0000-7000-8000-00000000000a";
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
vi.mock("../../utils/redis.js", () => ({
  redis: {
    mget: async (...keys: string[]) => keys.map(() => null),
    set: async () => "OK",
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

const never = () => new Promise<never>(() => undefined);

/** Whether `promise` has settled, without waiting for it. */
const settled = async (promise: Promise<unknown>) => {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true)
  );
  await vi.advanceTimersByTimeAsync(0);
  return done;
};

const unhandled = vi.fn();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(logger, "error").mockImplementation(() => undefined);
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  process.on("unhandledRejection", unhandled);
});
afterEach(async () => {
  await new Promise((r) => setImmediate(r));
  process.off("unhandledRejection", unhandled);
  expect(unhandled).not.toHaveBeenCalled();
  unhandled.mockReset();
  vi.useRealTimers();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

/** `call` rejects with `TereoUnreachableError` at the budget, not a millisecond before. */
const expectUnreachableAtBudget = async (call: Promise<unknown>) => {
  call.catch(() => undefined);
  await vi.advanceTimersByTimeAsync(DIRECTORY_BUDGET_MS - 1);
  expect(await settled(call)).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await expect(call).rejects.toBeInstanceOf(TereoUnreachableError);
};

describe("the directory's budget", () => {
  it("is 5000 ms", () => {
    expect(DIRECTORY_BUDGET_MS).toBe(5000);
  });

  it("a user search tereo never answers is tereo_unreachable at the budget, its requests aborted", async () => {
    sdk.handleRequest.mockImplementation(never);
    await expectUnreachableAtBudget(searchFromTereo("user", "ada", 5));
    const signals = sdk.handleRequest.mock.calls.map(
      ([c]) => (c as { signal?: AbortSignal }).signal
    );
    expect(signals).toHaveLength(2);
    for (const signal of signals) {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal!.aborted).toBe(true);
    }
  });

  it("a group search tereo never answers is tereo_unreachable at the budget", async () => {
    sdk.listGroups.mockImplementation(never);
    await expectUnreachableAtBudget(searchFromTereo("group", "ana", 5));
  });

  it("a user lookup tereo never answers is tereo_unreachable at the budget", async () => {
    sdk.getUsersByIds.mockImplementation(never);
    await expectUnreachableAtBudget(lookupFromTereo([{ type: "user", id: A }]));
  });

  it("a group lookup tereo never answers is tereo_unreachable at the budget, never orphaned", async () => {
    sdk.getUsersByIds.mockResolvedValue([]);
    auth.getGroup.mockImplementation(never);
    await expectUnreachableAtBudget(
      lookupFromTereo([
        { type: "user", id: A },
        { type: "group", id: G },
      ])
    );
  });

  it("a request that answers after the budget changes nothing and is not unhandled", async () => {
    let fail: (err: Error) => void = () => undefined;
    sdk.getUsersByIds.mockReturnValue(
      new Promise((_, reject) => {
        fail = reject;
      })
    );
    await expectUnreachableAtBudget(lookupFromTereo([{ type: "user", id: A }]));
    fail(new Error("late"));
    await vi.advanceTimersByTimeAsync(10);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("outlasts /v1/me's own deadline, so me answers first and the abandoned lookup ends by itself", async () => {
    expect(NAME_LOOKUP_DEADLINE_MS).toBeLessThan(DIRECTORY_BUDGET_MS);
    sdk.getUsersByIds.mockImplementation(never);
    const lookup = lookupFromTereo([{ type: "user", id: A }]);
    lookup.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(NAME_LOOKUP_DEADLINE_MS);
    expect(await settled(lookup)).toBe(false);
    await vi.advanceTimersByTimeAsync(
      DIRECTORY_BUDGET_MS - NAME_LOOKUP_DEADLINE_MS
    );
    await expect(lookup).rejects.toBeInstanceOf(TereoUnreachableError);
  });
});
