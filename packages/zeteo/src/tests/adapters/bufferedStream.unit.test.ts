// @module-tag unit
// @module-tag platform
import { bufferedStream } from "../../adapters/bufferedStream.js";
import { describe, expect, it, vi } from "vitest";

const COLUMNS = [{ name: "id", type: "number" as const }];
const ROWS = [[1], [2], [3]];

describe("bufferedStream", () => {
  it("hands its rows out in batches, then [] however often asked", async () => {
    const stream = bufferedStream(COLUMNS, ROWS);
    expect(stream.columns).toEqual(COLUMNS);
    expect(await stream.next(2)).toEqual([[1], [2]]);
    expect(await stream.next(2)).toEqual([[3]]);
    expect(await stream.next(2)).toEqual([]);
    expect(await stream.next(2)).toEqual([]);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses a batch of %s rows",
    async (size) => {
      const stream = bufferedStream(COLUMNS, ROWS);
      await expect(stream.next(size)).rejects.toThrow("invalid batch size");
      expect(await stream.next(3)).toEqual(ROWS);
    }
  );

  it("hands out no row once closed", async () => {
    const stream = bufferedStream(COLUMNS, ROWS);
    expect(await stream.next(1)).toEqual([[1]]);
    await stream.close();
    await expect(stream.next(1)).rejects.toThrow("closed");
  });

  it("calls onClose once, however often closed, and never throws", async () => {
    const onClose = vi.fn(() => Promise.reject(new Error("failed")));
    const stream = bufferedStream(COLUMNS, ROWS, onClose);
    await Promise.all([stream.close(), stream.close()]);
    await expect(stream.close()).resolves.toBeUndefined();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
