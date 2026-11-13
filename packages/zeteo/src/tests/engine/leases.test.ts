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

afterAll(async () => {
  if (used.length > 0) await redis.del(...used.map(leaseKey));
});

describe("acquireLease", () => {
  it("refuses the third lease of a key limited to two", async () => {
    const k = key();
    expect(await acquireLease(k, 2, 10_000)).toBeTypeOf("function");
    expect(await acquireLease(k, 2, 10_000)).toBeTypeOf("function");
    expect(await acquireLease(k, 2, 10_000)).toBeNull();
  });

  it("frees a slot on release", async () => {
    const k = key();
    const first = await acquireLease(k, 2, 10_000);
    await acquireLease(k, 2, 10_000);
    await first!();
    expect(await acquireLease(k, 2, 10_000)).toBeTypeOf("function");
    expect(await acquireLease(k, 2, 10_000)).toBeNull();
  });

  it("releases only its own slot, once, however often it is called", async () => {
    const k = key();
    const first = await acquireLease(k, 2, 10_000);
    await acquireLease(k, 2, 10_000);
    await first!();
    await first!();
    expect(await acquireLease(k, 2, 10_000)).toBeTypeOf("function");
    expect(await acquireLease(k, 2, 10_000)).toBeNull();
  });

  it("frees a slot whose lease expired without a release", async () => {
    const k = key();
    expect(await acquireLease(k, 1, 150)).toBeTypeOf("function");
    expect(await acquireLease(k, 1, 150)).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await acquireLease(k, 1, 150)).toBeTypeOf("function");
  });

  it("counts each key on its own", async () => {
    const a = key();
    const b = key();
    await acquireLease(a, 1, 10_000);
    expect(await acquireLease(a, 1, 10_000)).toBeNull();
    expect(await acquireLease(b, 1, 10_000)).toBeTypeOf("function");
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
