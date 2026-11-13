// @module-tag unit
// @module-tag platform
import { CHECK_POOL_SIZE, poolSizeFor } from "../../sources/connect.js";
import { describe, expect, it } from "vitest";

describe("poolSizeFor", () => {
  it.each([
    [5, 2, 9],
    [1, 1, 4],
    [50, 10, 62],
  ])(
    "opens two connections more than %s queries and %s exports at once: %s",
    (queryConcurrency, exportConcurrency, size) => {
      expect(poolSizeFor({ queryConcurrency, exportConcurrency })).toBe(size);
    }
  );

  it("gives a login check's own connection one connection", () => {
    expect(CHECK_POOL_SIZE).toBe(1);
  });
});
