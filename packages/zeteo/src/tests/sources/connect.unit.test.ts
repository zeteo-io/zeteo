// @module-tag unit
// @module-tag platform
import { CONNECT_OPTIONS, POOL_SIZE } from "../../sources/connect.js";
import { describe, expect, it } from "vitest";
import {
  EXPORT_SOURCE_CONCURRENCY,
  SOURCE_CONCURRENCY,
} from "../../engine/limits.js";

describe("CONNECT_OPTIONS", () => {
  it("opens two connections more than a source may run queries and exports at once", () => {
    expect(POOL_SIZE).toBe(SOURCE_CONCURRENCY + EXPORT_SOURCE_CONCURRENCY + 2);
    expect(CONNECT_OPTIONS.poolSize).toBe(POOL_SIZE);
  });
});
