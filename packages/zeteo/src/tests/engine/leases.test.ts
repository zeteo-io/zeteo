// @module-tag int
// @module-tag platform
import { acquireLease, leaseKey } from "../../engine/leases.js";
import { afterAll, describe, expect, it } from "vitest";
import { redis } from "../../utils/redis.js";
import { randomUUID } from "crypto";

const used: string[] = [];
const key = () => {
  const k = `test-${randomUUID()}`;
  used.push(k);
  return k;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterAll(async () => {
  if (used.length > 0) await redis.del(...used.map(leaseKey));
});

describe("acquireLease", () => {
  it("refuses the third lease of a key limited to two", async () => {
    const k = key();
    expect(await acquireLease(k, 2, 10_000)).not.toBeNull();
    expect(await acquireLease(k, 2, 10_000)).not.toBeNull();
    expect(await acquireLease(k, 2, 10_000)).toBeNull();
  });

  it("frees a slot on release", async () => {
    const k = key();
    const first = await acquireLease(k, 2, 10_000);
    await acquireLease(k, 2, 10_000);
    await first!.release();
    expect(await acquireLease(k, 2, 10_000)).not.toBeNull();
    expect(await acquireLease(k, 2, 10_000)).toBeNull();
  });

  it("releases only its own slot, once, however often it is called", async () => {
    const k = key();
    const first = await acquireLease(k, 2, 10_000);
    await acquireLease(k, 2, 10_000);
    await first!.release();
    await first!.release();
    expect(await acquireLease(k, 2, 10_000)).not.toBeNull();
    expect(await acquireLease(k, 2, 10_000)).toBeNull();
  });

  it("frees a slot whose lease expired without a release", async () => {
    const k = key();
    expect(await acquireLease(k, 1, 500)).not.toBeNull();
    expect(await acquireLease(k, 1, 500)).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(await acquireLease(k, 1, 500)).not.toBeNull();
  });

  it("counts each key on its own", async () => {
    const a = key();
    const b = key();
    await acquireLease(a, 1, 10_000);
    expect(await acquireLease(a, 1, 10_000)).toBeNull();
    expect(await acquireLease(b, 1, 10_000)).not.toBeNull();
  });

  it("lets the key expire in Redis once its last lease would have", async () => {
    const k = key();
    await acquireLease(k, 2, 10_000);
    const ttl = await redis.pttl(leaseKey(k));
    expect(ttl).toBeGreaterThan(9_000);
    expect(ttl).toBeLessThanOrEqual(10_000);
    // A shorter lease does not shorten the key's life.
    await acquireLease(k, 2, 1_000);
    expect(await redis.pttl(leaseKey(k))).toBeGreaterThan(9_000);
  });

  it("hands out no more than the limit to concurrent callers", async () => {
    const k = key();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => acquireLease(k, 3, 10_000))
    );
    expect(results.filter((r) => r !== null)).toHaveLength(3);
  });
});

describe("acquireLease: renew", () => {
  it("keeps a renewed lease past its first expiry", async () => {
    const k = key();
    const lease = await acquireLease(k, 1, 600);
    expect(lease).not.toBeNull();
    await sleep(300);
    await lease!.renew(3000);
    await sleep(900);
    expect(await acquireLease(k, 1, 600)).toBeNull();
    await lease!.release();
    expect(await acquireLease(k, 1, 600)).not.toBeNull();
  });

  it("frees the slot of a lease that is not renewed", async () => {
    const k = key();
    expect(await acquireLease(k, 1, 300)).not.toBeNull();
    await sleep(900);
    expect(await acquireLease(k, 1, 300)).not.toBeNull();
  });

  it("does not take back a slot once the lease is released", async () => {
    const k = key();
    const lease = await acquireLease(k, 1, 10_000);
    await lease!.release();
    await expect(lease!.renew(10_000)).resolves.toBeUndefined();
    expect(await redis.zcard(leaseKey(k))).toBe(0);
    expect(await acquireLease(k, 1, 10_000)).not.toBeNull();
  });

  it("does not take back a slot once the lease has lapsed", async () => {
    const k = key();
    const lease = await acquireLease(k, 1, 300);
    await sleep(900);
    const other = await acquireLease(k, 1, 10_000);
    expect(other).not.toBeNull();
    await lease!.renew(10_000);
    expect(await redis.zcard(leaseKey(k))).toBe(1);
    await other!.release();
    expect(await redis.zcard(leaseKey(k))).toBe(0);
  });

  it("keeps the key alive in Redis as long as the renewed lease", async () => {
    const k = key();
    const lease = await acquireLease(k, 1, 1000);
    await lease!.renew(20_000);
    expect(await redis.pttl(leaseKey(k))).toBeGreaterThan(19_000);
  });
});
