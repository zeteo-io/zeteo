// @module-tag unit
// @module-tag platform
import { acquireRunLeases, runLimits } from "../../engine/limits.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooManyRequestsError } from "../../utils/errors.js";
import { acquireLease } from "../../engine/leases.js";

vi.mock(import("../../engine/leases.js"), () => ({
  acquireLease: vi.fn(),
  leaseKey: (key: string) => `zeteo:lease:${key}`,
}));

const lease = vi.mocked(acquireLease);

afterEach(() => {
  lease.mockReset();
});

describe("acquireRunLeases", () => {
  it("releases the user's lease even when releasing the source's throws", async () => {
    const releaseUser = vi.fn().mockResolvedValue(undefined);
    const releaseSource = vi.fn().mockRejectedValue(new Error("redis down"));
    lease
      .mockResolvedValueOnce(releaseUser)
      .mockResolvedValueOnce(releaseSource);
    const release = await acquireRunLeases("u", "s", 1000);
    await expect(release()).resolves.toBeUndefined();
    expect(releaseSource).toHaveBeenCalledOnce();
    expect(releaseUser).toHaveBeenCalledOnce();
  });

  it("releases the user's lease when the source refuses, and answers source_busy", async () => {
    const releaseUser = vi.fn().mockRejectedValue(new Error("redis down"));
    lease.mockResolvedValueOnce(releaseUser).mockResolvedValueOnce(null);
    const err = await acquireRunLeases("u", "s", 1000).catch((e) => e);
    expect(err).toBeInstanceOf(TooManyRequestsError);
    expect(err.code).toBe("source_busy");
    expect(releaseUser).toHaveBeenCalledOnce();
  });

  it("takes no source lease when the user's is refused", async () => {
    lease.mockResolvedValueOnce(null);
    const err = await acquireRunLeases("u", "s", 1000).catch((e) => e);
    expect(err.code).toBe("too_many_queries");
    expect(lease).toHaveBeenCalledOnce();
  });
});

describe("runLimits", () => {
  it.each([
    [undefined, 50_000, 1000],
    [5, 50_000, 5],
    [1_000_000, 50_000, 50_000],
    [1_000_000, 3, 3],
    [undefined, 3, 3],
  ])("limit %s with row cap %s allows %s rows", (limit, rowCap, rows) => {
    expect(runLimits("api", limit, { rowCap, timeoutMs: 1000 })).toEqual({
      maxRows: rows,
      maxBytes: 10 * 1024 * 1024,
      timeoutMs: 1000,
    });
  });

  it("uses the MCP profile's default and caps", () => {
    expect(
      runLimits("mcp", undefined, { rowCap: 50_000, timeoutMs: 1000 })
    ).toMatchObject({ maxRows: 100, maxBytes: 1024 * 1024 });
    expect(
      runLimits("mcp", 10_000, { rowCap: 50_000, timeoutMs: 1000 }).maxRows
    ).toBe(5000);
  });
});
