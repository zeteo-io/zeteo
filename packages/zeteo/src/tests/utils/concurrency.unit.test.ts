// @module-tag unit
// @module-tag platform
import { mapConcurrently } from "../../utils/concurrency.js";
import { describe, expect, it } from "vitest";

const tick = () => new Promise((r) => setImmediate(r));

describe("mapConcurrently", () => {
  it("keeps the items' order and never runs more than the limit at once", async () => {
    let inFlight = 0;
    let most = 0;
    const out = await mapConcurrently(
      Array.from({ length: 20 }, (_, i) => i),
      3,
      async (n) => {
        most = Math.max(most, ++inFlight);
        await tick();
        inFlight--;
        return n * 2;
      }
    );
    expect(out).toEqual(Array.from({ length: 20 }, (_, i) => i * 2));
    expect(most).toBe(3);
  });

  it("starts nothing more after one fails, and rejects with that failure", async () => {
    const started: number[] = [];
    await expect(
      mapConcurrently([0, 1, 2, 3, 4, 5], 2, async (n) => {
        started.push(n);
        await tick();
        if (n === 0) throw new Error("boom");
        await tick();
      })
    ).rejects.toThrow("boom");
    await tick();
    await tick();
    expect(started).toEqual([0, 1]);
  });

  it("starts nothing more once the signal aborts", async () => {
    const controller = new AbortController();
    const started: number[] = [];
    const done = mapConcurrently(
      [0, 1, 2, 3],
      1,
      async (n) => {
        started.push(n);
        await tick();
      },
      controller.signal
    );
    controller.abort();
    await expect(done).rejects.toThrow();
    expect(started).toEqual([0]);
  });

  it("is an empty list for no items", async () => {
    expect(await mapConcurrently([], 8, async () => 1)).toEqual([]);
  });
});
