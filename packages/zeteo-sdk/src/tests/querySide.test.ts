import { useStubbedClient } from "./support/callContext.js";
import { catalogCalls } from "../calls/catalog.js";
import { healthCalls } from "../calls/health.js";
import { queryCalls } from "../calls/query.js";
import type { Query } from "../types/query.js";
import { describe, expect, it } from "vitest";
import { runsCalls } from "../calls/runs.js";

describe("query-side calls", () => {
  const t = useStubbedClient();

  it("health.get calls GET /health with the service token even for a person's context", async () => {
    const body = { status: "ok", postgres: "ok", redis: "ok" };
    t.stub.respond(() => ({ body }));
    expect(await healthCalls(t.ctx("p-1")).get()).toEqual(body);
    expect(t.stub.requests[0]).toMatchObject({
      method: "GET",
      path: "/health",
    });
    expect(t.stub.requests[0].headers.authorization).toBe("Bearer svc-1");
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
