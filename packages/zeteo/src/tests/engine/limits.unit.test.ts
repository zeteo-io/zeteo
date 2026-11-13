// @module-tag unit
// @module-tag platform
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireLease } from "../../engine/leases.js";
import {
  acquireExportLeases,
  acquireRunLeases,
  runLimits,
} from "../../engine/limits.js";
import {
  ServiceUnavailableError,
  TooManyRequestsError,
} from "../../utils/errors.js";

vi.mock(import("../../engine/leases.js"), () => ({
  acquireLease: vi.fn(),
  leaseKey: (key: string) => `zeteo:lease:${key}`,
}));

const lease = vi.mocked(acquireLease);
/** A lease whose release is `release`. */
const held = (release: () => Promise<void>) => ({
  release,
  renew: vi.fn().mockResolvedValue(undefined),
});

afterEach(() => {
  lease.mockReset();
});

const SOURCE = { id: "s", queryConcurrency: 4, exportConcurrency: 3 };
const USER = { queryConcurrency: 7, exportConcurrency: 2 };

describe("acquireRunLeases", () => {
  it("takes one of the user's query slots and one of the source's, at their limits", async () => {
    lease
      .mockResolvedValueOnce(held(vi.fn()))
      .mockResolvedValueOnce(held(vi.fn()));
    await acquireRunLeases("u", SOURCE, 1000, USER);
    expect(lease.mock.calls).toEqual([
      ["user:u", 7, 1000],
      ["source:s", 4, 1000],
    ]);
  });

  it.each([
    [{ queryConcurrency: 1 }, "At most 1 query may run at once for one user"],
    [{ queryConcurrency: 3 }, "At most 3 queries may run at once for one user"],
  ])("states the user's limit %o in the refusal", async (user, message) => {
    lease.mockResolvedValueOnce(null);
    const err = await acquireRunLeases("u", SOURCE, 1000, {
      ...USER,
      ...user,
    }).catch((e) => e);
    expect(err.message).toBe(message);
  });

  it.each([
    [1, "The source runs at most 1 query at once; retry shortly"],
    [6, "The source runs at most 6 queries at once; retry shortly"],
  ])("states the source's limit %s in the refusal", async (limit, message) => {
    lease.mockResolvedValueOnce(held(vi.fn())).mockResolvedValueOnce(null);
    const err = await acquireRunLeases(
      "u",
      { id: "s", queryConcurrency: limit },
      1000,
      USER
    ).catch((e) => e);
    expect(err.message).toBe(message);
  });

  it("releases the user's lease even when releasing the source's throws", async () => {
    const releaseUser = vi.fn().mockResolvedValue(undefined);
    const releaseSource = vi.fn().mockRejectedValue(new Error("redis down"));
    lease
      .mockResolvedValueOnce(held(releaseUser))
      .mockResolvedValueOnce(held(releaseSource));
    const release = await acquireRunLeases("u", SOURCE, 1000, USER);
    await expect(release()).resolves.toBeUndefined();
    expect(releaseSource).toHaveBeenCalledOnce();
    expect(releaseUser).toHaveBeenCalledOnce();
  });

  it("releases the user's lease when the source refuses, and answers source_busy", async () => {
    const releaseUser = vi.fn().mockRejectedValue(new Error("redis down"));
    lease.mockResolvedValueOnce(held(releaseUser)).mockResolvedValueOnce(null);
    const err = await acquireRunLeases("u", SOURCE, 1000, USER).catch((e) => e);
    expect(err).toBeInstanceOf(TooManyRequestsError);
    expect(err.code).toBe("source_busy");
    expect(releaseUser).toHaveBeenCalledOnce();
  });

  it("does not wait for the user's release when the source refuses", async () => {
    const releaseUser = vi.fn(() => new Promise<void>(() => undefined));
    lease.mockResolvedValueOnce(held(releaseUser)).mockResolvedValueOnce(null);
    const err = await acquireRunLeases("u", SOURCE, 1000, USER).catch((e) => e);
    expect(err.code).toBe("source_busy");
    expect(releaseUser).toHaveBeenCalledOnce();
  });

  it("does not wait for the user's release when the source's lease fails", async () => {
    const releaseUser = vi.fn(() => new Promise<void>(() => undefined));
    lease
      .mockResolvedValueOnce(held(releaseUser))
      .mockRejectedValueOnce(new ServiceUnavailableError("redis down"));
    const err = await acquireRunLeases("u", SOURCE, 1000, USER).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableError);
    expect(releaseUser).toHaveBeenCalledOnce();
  });

  it("takes no source lease when the user's is refused", async () => {
    lease.mockResolvedValueOnce(null);
    const err = await acquireRunLeases("u", SOURCE, 1000, USER).catch((e) => e);
    expect(err.code).toBe("too_many_queries");
    expect(lease).toHaveBeenCalledOnce();
  });
});

describe("acquireExportLeases", () => {
  it("takes one of a user's export slots and one of the source's, under keys of their own", async () => {
    lease
      .mockResolvedValueOnce(held(vi.fn()))
      .mockResolvedValueOnce(held(vi.fn()));
    await acquireExportLeases("u", SOURCE, 30_000, USER);
    expect(lease.mock.calls).toEqual([
      ["export:user:u", 2, 30_000],
      ["export:source:s", 3, 30_000],
    ]);
  });

  it("refuses with too_many_exports when the user's slot is taken", async () => {
    lease.mockResolvedValueOnce(null);
    const err = await acquireExportLeases("u", SOURCE, 1000, USER).catch(
      (e) => e
    );
    expect(err).toBeInstanceOf(TooManyRequestsError);
    expect(err.code).toBe("too_many_exports");
    expect(err.message).toBe("At most 2 exports may run at once for one user");
    expect(lease).toHaveBeenCalledOnce();
  });

  it("refuses with source_busy when the source's slots are taken, releasing the user's", async () => {
    const releaseUser = vi.fn().mockResolvedValue(undefined);
    lease.mockResolvedValueOnce(held(releaseUser)).mockResolvedValueOnce(null);
    const err = await acquireExportLeases("u", SOURCE, 1000, USER).catch(
      (e) => e
    );
    expect(err.code).toBe("source_busy");
    expect(err.message).toBe(
      "The source runs at most 3 exports at once; retry shortly"
    );
    expect(releaseUser).toHaveBeenCalledOnce();
  });

  it("renews and releases both leases", async () => {
    const user = held(vi.fn().mockResolvedValue(undefined));
    const source = held(vi.fn().mockResolvedValue(undefined));
    lease.mockResolvedValueOnce(user).mockResolvedValueOnce(source);
    const leases = await acquireExportLeases("u", SOURCE, 1000, USER);
    await leases.renew(5000);
    expect(user.renew).toHaveBeenCalledWith(5000);
    expect(source.renew).toHaveBeenCalledWith(5000);
    await leases.release();
    expect(user.release).toHaveBeenCalledOnce();
    expect(source.release).toHaveBeenCalledOnce();
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
