// @module-tag unit
// @module-tag platform
import { lookupPrincipals } from "../../../../principals/directory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../../../utils/logger.js";
import type { Request, Response } from "express";
import {
  getMeHandler,
  NAME_LOOKUP_DEADLINE_MS,
} from "../../../../routes/v1/me/controllers.js";

vi.mock("../../../../principals/directory.js", () => ({
  lookupPrincipals: vi.fn(),
}));

const USER = "0197d000-0000-7000-8000-000000000001";

const run = () => {
  const req = {
    caller: {
      userId: USER,
      organizationId: null,
      permissions: ["zeteo.data.read"],
      isServiceAccount: false,
    },
  } as Request;
  const json = vi.fn();
  const res = {
    setHeader: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json,
  } as unknown as Response;
  return { done: getMeHandler(req, res), json };
};

describe("getMeHandler name lookup deadline", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("answers null name and email once the deadline passes, warns once, and ignores a late rejection", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    let rejectLate: (e: Error) => void = () => {};
    vi.mocked(lookupPrincipals).mockReturnValue(
      new Promise((_, reject) => {
        rejectLate = reject;
      })
    );
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const { done, json } = run();
      await vi.advanceTimersByTimeAsync(NAME_LOOKUP_DEADLINE_MS - 1);
      expect(json).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await done;

      expect(json).toHaveBeenCalledWith({
        id: USER,
        type: "user",
        name: null,
        email: null,
        permissions: ["zeteo.data.read"],
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/Ada|@/);

      rejectLate(new Error("late failure"));
      await vi.advanceTimersByTimeAsync(10);
      await new Promise((r) => setImmediate(r));
      expect(unhandled).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
