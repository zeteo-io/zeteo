// @module-tag unit
// @module-tag platform
import { REDIS_COMMAND_TIMEOUT_MS } from "../../utils/redisTimeout.js";
import { ServiceUnavailableError } from "../../utils/errors.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireLease } from "../../engine/leases.js";

// Commands of a client whose Redis is gone: the shared client queues them
// while it reconnects and never settles them.
const redis = vi.hoisted(() => ({ eval: vi.fn(), zrem: vi.fn() }));
vi.mock("../../utils/redis.js", () => ({ redis }));
const never = () => new Promise<never>(() => undefined);
// The bound, plus room for a slow runner.
const WITHIN_MS = REDIS_COMMAND_TIMEOUT_MS + 1500;

afterEach(() => vi.resetAllMocks());

describe("acquireLease when Redis fails", () => {
  it("answers 503 within its bound when Redis never answers", async () => {
    redis.eval.mockImplementation(never);
    const started = Date.now();
    const err = await acquireLease("k", 2, 10_000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableError);
    expect(Date.now() - started).toBeLessThan(WITHIN_MS);
  });

  it("answers 503 when Redis refuses the command", async () => {
    redis.eval.mockRejectedValue(new Error("Connection is closed"));
    await expect(acquireLease("k", 2, 10_000)).rejects.toBeInstanceOf(
      ServiceUnavailableError
    );
  });

  it("ends a release within its bound when Redis never answers", async () => {
    redis.eval.mockResolvedValue(1);
    redis.zrem.mockImplementation(never);
    const lease = await acquireLease("k", 2, 10_000);
    const started = Date.now();
    await expect(lease!.release()).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(WITHIN_MS);
  });

  it("ends a renewal within its bound, without throwing, when Redis never answers", async () => {
    redis.eval.mockResolvedValueOnce(1).mockImplementation(never);
    const lease = await acquireLease("k", 2, 10_000);
    const started = Date.now();
    await expect(lease!.renew(10_000)).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(WITHIN_MS);
  });

  it("does not throw when Redis refuses a renewal", async () => {
    redis.eval
      .mockResolvedValueOnce(1)
      .mockRejectedValue(new Error("Connection is closed"));
    const lease = await acquireLease("k", 2, 10_000);
    await expect(lease!.renew(10_000)).resolves.toBeUndefined();
  });
});
