// @module-tag unit
// @module-tag platform
import { acceptsGzip } from "../../export/httpSink.js";
import { describe, expect, it } from "vitest";

describe("acceptsGzip", () => {
  it.each([
    ["gzip", true],
    ["GZIP", true],
    ["deflate, gzip;q=0.5", true],
    ["br;q=1, gzip ; q=0.001", true],
    ["*", true],
    ["identity, *;q=0.1", true],
    ["x-gzip", false],
    ["gzip;q=0", false],
    ["gzip;q=0.000", false],
    ["*;q=0", false],
    ["gzip;q=0, *", false],
    ["*, gzip;q=0", false],
    ["deflate, br", false],
    ["identity", false],
    ["", false],
    ["gzip;q=abc", false],
    ["gzip;q=2", false],
    ["gzipped", false],
  ])("%j -> %s", (header, expected) => {
    expect(acceptsGzip(header)).toBe(expected);
  });

  it("answers false when there is no header", () => {
    expect(acceptsGzip(undefined)).toBe(false);
  });
});
