import { useStubbedClient } from "./support/callContext.js";
import { catalogCalls } from "../calls/catalog.js";
import { healthCalls } from "../calls/health.js";
import { queryCalls } from "../calls/query.js";
import type { Query } from "../types/query.js";
import { describe, expect, it } from "vitest";
import { runsCalls } from "../calls/runs.js";

describe("query-side calls", () => {
  const t = useStubbedClient();

  describe("health.get", () => {
    const body = { status: "ok", postgres: "ok", redis: "ok" };
    const degraded = { status: "degraded", postgres: "ok", redis: "fail" };

    it("calls GET /health with no Authorization and no service token", async () => {
      t.stub.respond(() => ({ body }));
      expect(await healthCalls(t.ctx()).get()).toEqual(body);
      expect(t.stub.requests[0]).toMatchObject({
        method: "GET",
        path: "/health",
      });
      expect(t.stub.requests[0].headers.authorization).toBeUndefined();
      expect(t.stub.tokensIssued).toBe(0);
    });

    it("sends no Authorization even with a person token", async () => {
      t.stub.respond(() => ({ body }));
      await healthCalls(t.ctx("p-1")).get();
      expect(t.stub.requests[0].headers.authorization).toBeUndefined();
      expect(t.stub.tokensIssued).toBe(0);
    });

    it("resolves with the body of a 503 and makes one request", async () => {
      t.stub.respond(() => ({ status: 503, body: degraded }));
      expect(await healthCalls(t.ctx()).get()).toEqual(degraded);
      expect(t.stub.requests).toHaveLength(1);
    });

    it("throws on a 503 without a health body", async () => {
      t.stub.respond(() => ({ status: 503, body: {} }));
      await expect(healthCalls(t.ctx()).get()).rejects.toMatchObject({
        status: 503,
        code: "http_503",
      });
    });

    it("throws on a 500 after one request", async () => {
      t.stub.respond(() => ({ status: 500, body: { error: "boom" } }));
      await expect(healthCalls(t.ctx()).get()).rejects.toMatchObject({
        status: 500,
      });
      expect(t.stub.requests).toHaveLength(1);
    });
  });

  it("catalog.get calls GET /v1/catalog, with source when given", async () => {
    t.stub.respond(() => ({ body: { sources: [] } }));
    const calls = catalogCalls(t.ctx("p-1"));
    expect(await calls.get()).toEqual({ sources: [] });
    await calls.get({ source: "sales-db" });
    expect(t.stub.requests[0]).toMatchObject({
      method: "GET",
      path: "/v1/catalog",
      query: {},
    });
    expect(t.stub.requests[0].headers.authorization).toBe("Bearer p-1");
    expect(t.stub.requests[1].query).toEqual({ source: "sales-db" });
  });

  it("query.run posts the query to /v1/query and returns the result", async () => {
    const result = {
      columns: [{ name: "n", type: "number" }],
      rows: [[1]],
      truncated: false,
      warnings: [],
      run_id: "r1",
    };
    t.stub.respond(() => ({ body: result }));
    const query: Query = {
      source: "sales-db",
      from: "orders",
      select: ["id", { sum: "total", as: "revenue" }],
      where: { status: { in: ["paid"] } },
    };
    expect(await queryCalls(t.ctx("p-1")).run(query)).toEqual(result);
    expect(t.stub.requests[0]).toMatchObject({
      method: "POST",
      path: "/v1/query",
      body: query,
    });
  });

  it("query.run is repeated after a 5xx", async () => {
    let n = 0;
    t.stub.respond(() =>
      ++n === 1
        ? { status: 503, body: { error: "unavailable" } }
        : { body: { rows: [] } }
    );
    await queryCalls(t.ctx("p-1")).run({
      source: "s",
      from: "t",
      select: ["a"],
    });
    expect(t.stub.requests).toHaveLength(2);
  });

  it("query.run rejects with code aborted when the signal aborts", async () => {
    t.stub.respond(() => ({ body: {} }));
    const controller = new AbortController();
    controller.abort();
    await expect(
      queryCalls(t.ctx("p-1")).run(
        { source: "s", from: "t", select: ["a"] },
        { signal: controller.signal }
      )
    ).rejects.toMatchObject({ code: "aborted" });
  });

  it("runs.list calls GET /v1/runs with its filters", async () => {
    const page = { data: [], next_cursor: null };
    t.stub.respond(() => ({ body: page }));
    const calls = runsCalls(t.ctx("p-1"));
    expect(await calls.list()).toEqual(page);
    await calls.list({
      limit: 10,
      cursor: "c1",
      user_id: "u1",
      source_id: "s1",
      outcome: "refused",
    });
    expect(t.stub.requests[0]).toMatchObject({
      method: "GET",
      path: "/v1/runs",
      query: {},
    });
    expect(t.stub.requests[1].query).toEqual({
      limit: "10",
      cursor: "c1",
      user_id: "u1",
      source_id: "s1",
      outcome: "refused",
    });
  });
});
