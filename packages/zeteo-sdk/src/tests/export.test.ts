import { useStubbedClient } from "./support/callContext.js";
import { exportCalls } from "../calls/export.js";
import type { Query } from "../types/query.js";
import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import {
  ExportInterruptedError,
  QueryRefusedError,
  ZeteoError,
} from "../errors.js";

const RUN = "0193f1c2-7a4e-7c3d-9b1a-2f6e8d0c4b5a";
const query: Query = { source: "sales-db", from: "orders", select: ["id"] };
const head = `${JSON.stringify({
  columns: [{ name: "id", type: "number" }],
  warnings: [],
  run_id: RUN,
})}\n`;
const end = (status: string, rows: number) =>
  `${JSON.stringify({ status, rows })}\n`;
const runHeader = { "x-zeteo-run-id": RUN };

const caught = async (p: Promise<unknown>): Promise<unknown> => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("did not throw");
};

const readAll = async (rows: AsyncIterable<unknown[]>) => {
  const out: unknown[][] = [];
  for await (const row of rows) out.push(row);
  return out;
};

describe("export", () => {
  const t = useStubbedClient();

  describe("rows", () => {
    it("reads the head, every row and the end", async () => {
      t.stub.respond(() => ({
        headers: runHeader,
        chunks: [head, "[1]\n[2]\n", "[3]\n", end("complete", 3)],
      }));
      const result = await exportCalls(t.ctx("p-1")).rows(query);
      expect(result.runId).toBe(RUN);
      expect(result.columns).toEqual([{ name: "id", type: "number" }]);
      expect(result.warnings).toEqual([]);
      expect(await readAll(result.rows)).toEqual([[1], [2], [3]]);
      expect(await result.done).toEqual({ status: "complete", rows: 3 });

      const sent = t.stub.requests[0];
      expect(sent).toMatchObject({
        method: "POST",
        path: "/v1/export",
        query: { format: "ndjson" },
        body: query,
      });
      expect(sent.headers.authorization).toBe("Bearer p-1");
      expect(sent.headers["accept-encoding"]).toBe("gzip");
    });

    it("resolves done with a truncated end", async () => {
      t.stub.respond(() => ({ chunks: [head, "[1]\n", end("truncated", 1)] }));
      const result = await exportCalls(t.ctx()).rows(query);
      expect(await readAll(result.rows)).toEqual([[1]]);
      expect(await result.done).toEqual({ status: "truncated", rows: 1 });
    });

    it("decodes a gzipped body", async () => {
      const body = gzipSync(head + "[1]\n[2]\n" + end("complete", 2));
      const mid = Math.floor(body.length / 2);
      t.stub.respond(() => ({
        headers: { "content-encoding": "gzip" },
        chunks: [body.subarray(0, mid), body.subarray(mid)],
      }));
      const result = await exportCalls(t.ctx()).rows(query);
      expect(await readAll(result.rows)).toEqual([[1], [2]]);
      expect(await result.done).toEqual({ status: "complete", rows: 2 });
    });

    it("throws ExportInterruptedError when the connection is cut, and done rejects with it", async () => {
      t.stub.respond(() => ({
        headers: runHeader,
        chunks: [head, "[1]\n"],
        cutAfterChunks: true,
      }));
      const result = await exportCalls(t.ctx()).rows(query);
      const seen: unknown[] = [];
      const error = await caught(
        (async () => {
          for await (const row of result.rows) seen.push(row);
        })()
      );
      expect(seen).toEqual([[1]]);
      expect(error).toBeInstanceOf(ExportInterruptedError);
      expect(error).toMatchObject({ runId: RUN, rowsRead: 1 });
      expect(await caught(result.done)).toBe(error);
    });

    it("throws ExportInterruptedError when the stream ends without its end line", async () => {
      t.stub.respond(() => ({ chunks: [head, "[1]\n"] }));
      const result = await exportCalls(t.ctx()).rows(query);
      const error = await caught(readAll(result.rows));
      expect(error).toBeInstanceOf(ExportInterruptedError);
      expect(error).toMatchObject({ runId: RUN, rowsRead: 1 });
      expect(await caught(result.done)).toBe(error);
    });

    it("throws ExportInterruptedError on a line that is not JSON", async () => {
      t.stub.respond(() => ({ chunks: [head, "[1]\n", "nope\n"] }));
      const result = await exportCalls(t.ctx()).rows(query);
      const error = await caught(readAll(result.rows));
      expect(error).toMatchObject({
        name: "ExportInterruptedError",
        rowsRead: 1,
      });
      expect(await caught(result.done)).toBe(error);
    });

    it("closes the connection when the reader stops early, without throwing", async () => {
      t.stub.respond(() => ({
        chunks: [head, ...Array.from({ length: 50 }, (_, i) => `[${i}]\n`)],
      }));
      const result = await exportCalls(t.ctx()).rows(query);
      for await (const row of result.rows) {
        expect(row).toEqual([0]);
        break;
      }
      const error = await caught(result.done);
      expect(error).toBeInstanceOf(ExportInterruptedError);
      expect(error).toMatchObject({ runId: RUN, rowsRead: 1 });
      await expect
        .poll(() => t.stub.cutByClient, { timeout: 1000 })
        .toEqual(["/v1/export"]);
    });

    it("throws when the signal aborts mid-stream", async () => {
      t.stub.respond(() => ({
        chunks: [head, ...Array.from({ length: 50 }, (_, i) => `[${i}]\n`)],
      }));
      const controller = new AbortController();
      const result = await exportCalls(t.ctx()).rows(query, {
        signal: controller.signal,
      });
      const error = await caught(
        (async () => {
          for await (const row of result.rows) {
            if ((row as number[])[0] === 1) controller.abort();
          }
        })()
      );
      expect(error).toBeInstanceOf(ExportInterruptedError);
      expect(await caught(result.done)).toBe(error);
      await expect
        .poll(() => t.stub.cutByClient, { timeout: 1000 })
        .toEqual(["/v1/export"]);
    });

    it("maps a 422 before the stream to QueryRefusedError", async () => {
      t.stub.respond(() => ({
        status: 422,
        body: {
          error: "not_found_or_not_accessible",
          error_description: "no such column",
          path: ["select", 0],
          suggestions: ["idx"],
        },
      }));
      const error = await caught(exportCalls(t.ctx()).rows(query));
      expect(error).toBeInstanceOf(QueryRefusedError);
      expect(error).toMatchObject({
        status: 422,
        code: "not_found_or_not_accessible",
        message: "no such column",
        path: ["select", 0],
        suggestions: ["idx"],
      });
    });

    it("maps a 429 to ZeteoError with retryAfter, after one request", async () => {
      t.stub.respond(() => ({
        status: 429,
        headers: { "retry-after": "30" },
        body: { error: "too_many_exports", retry_after: 12 },
      }));
      const error = await caught(exportCalls(t.ctx("p-1")).rows(query));
      expect(error).toBeInstanceOf(ZeteoError);
      expect(error).toMatchObject({
        status: 429,
        code: "too_many_exports",
        retryAfter: 12,
      });
      expect(t.stub.requests).toHaveLength(1);
    });

    it.each([
      ["the service", undefined],
      ["a person", "p-1"],
    ])("makes one request on a 500 as %s", async (_, token) => {
      t.stub.respond(() => ({ status: 500, body: { error: "internal" } }));
      const error = await caught(exportCalls(t.ctx(token)).rows(query));
      expect(error).toMatchObject({ status: 500, code: "internal" });
      expect(t.stub.requests).toHaveLength(1);
    });

    it("renews the service token once after a streamed 401", async () => {
      t.stub.respond((req) =>
        req.headers.authorization === "Bearer svc-1"
          ? { status: 401, body: { error: "invalid_token" } }
          : { chunks: [head, end("complete", 0)] }
      );
      const result = await exportCalls(t.ctx()).rows(query);
      expect(await readAll(result.rows)).toEqual([]);
      expect(t.stub.requests.map((r) => r.headers.authorization)).toEqual([
        "Bearer svc-1",
        "Bearer svc-2",
      ]);
    });

    it("can be read only once", async () => {
      t.stub.respond(() => ({ chunks: [head, end("complete", 0)] }));
      const result = await exportCalls(t.ctx()).rows(query);
      await readAll(result.rows);
      expect(() => result.rows[Symbol.asyncIterator]()).toThrow(
        "@zeteo-io/sdk: export rows can be read only once"
      );
    });
  });

  describe("stream", () => {
    it("sends ?format=csv and yields the body with the run id from the header", async () => {
      const csv = "id,status\r\n1,paid\r\n2,paid\r\n";
      t.stub.respond(() => ({
        headers: { ...runHeader, "content-type": "text/csv; charset=utf-8" },
        chunks: [csv.slice(0, 12), csv.slice(12)],
      }));
      const result = await exportCalls(t.ctx("p-1")).stream(query, {
        format: "csv",
      });
      expect(result.runId).toBe(RUN);
      const parts: Buffer[] = [];
      for await (const part of result.stream) parts.push(part as Buffer);
      expect(Buffer.concat(parts).toString()).toBe(csv);
      expect(t.stub.requests[0]).toMatchObject({
        path: "/v1/export",
        query: { format: "csv" },
      });
      expect(t.stub.requests[0].headers["accept-encoding"]).toBe("gzip");
    });

    it("yields a gzipped body decompressed", async () => {
      const body = head + end("complete", 0);
      t.stub.respond(() => ({
        headers: { ...runHeader, "content-encoding": "gzip" },
        chunks: [gzipSync(body)],
      }));
      const result = await exportCalls(t.ctx()).stream(query);
      const parts: Buffer[] = [];
      for await (const part of result.stream) parts.push(part as Buffer);
      expect(Buffer.concat(parts).toString()).toBe(body);
      expect(t.stub.requests[0].query).toEqual({ format: "ndjson" });
    });
  });
});
