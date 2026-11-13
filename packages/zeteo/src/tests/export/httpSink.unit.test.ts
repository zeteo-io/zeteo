// @module-tag unit
// @module-tag platform
import type { Request, Response } from "express";
import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import {
  acceptsGzip,
  EXPORT_CHUNK_BYTES,
  httpSink,
} from "../../export/httpSink.js";

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

/** A response that records the size of every chunk written to it. */
const recordingResponse = () => {
  const chunks: number[] = [];
  const res = new Writable({
    highWaterMark: 16 * 1024,
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk.length);
      setImmediate(done);
    },
  });
  Object.assign(res, {
    status: () => res,
    setHeader: () => undefined,
    flushHeaders: () => undefined,
    addTrailers: () => undefined,
  });
  return { res: res as unknown as Response, chunks };
};

describe("httpSink", () => {
  it.each(["ndjson", "csv"] as const)(
    "writes a %s batch in chunks no larger than one chunk or one row, not as one string",
    async (format) => {
      const { res, chunks } = recordingResponse();
      const req = { headers: {} } as Request;
      const sink = httpSink(req, res, format);
      await sink.start({
        columns: [
          { name: "id", type: "number" },
          { name: "filler", type: "text" },
        ],
        warnings: [],
        runId: "run",
      });
      const narrow = Array.from({ length: 2000 }, (_, i) => [
        i,
        "n".repeat(100),
      ]);
      const wide = Array.from({ length: 8 }, (_, i) => [
        i,
        "w".repeat(300_000),
      ]);
      await sink.rows(narrow);
      await sink.rows(wide);
      const total = chunks.reduce((sum, n) => sum + n, 0);
      expect(total).toBeGreaterThan(8 * 300_000 + 2000 * 100);
      expect(Math.max(...chunks)).toBeLessThan(EXPORT_CHUNK_BYTES + 300_100);
      // The narrow batch, about 220 KB, went out in several chunks.
      expect(chunks.length).toBeGreaterThan(8 + 3);
    }
  );
});
