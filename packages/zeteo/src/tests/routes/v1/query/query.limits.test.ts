// @module-tag int
// @module-tag platform
// @module-tag slow
import { describeEachEngine } from "../../../support/engines.js";
import type { JsonResponse } from "../../../support/http.js";
import { removeSources } from "../../../support/sources.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { BASE_URL } from "../../../support/http.js";
import {
  grantTo,
  newQueryUser,
  postQuery,
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../../../support/queries.js";

// Words only a database or driver would put in an error.
const DRIVER_TEXT =
  /service:|postgres|pg_|sqlstate|statement|cancel|sleep|division|syntax|relation "|ERROR:/i;

describeEachEngine("POST /v1/query: limits", (engine) => {
  let source: SeededSource;
  let quick: SeededSource;
  let capped: SeededSource;
  const users: string[] = [];
  const errorBodies: unknown[] = [];

  /** A user granted every portable table of `on`, and the slow and broken views. */
  const grantedUser = async (on: SeededSource) => {
    const user = newQueryUser();
    users.push(user.id);
    for (const table of ["orders", "slow_orders", "broken_orders"]) {
      await grantTo(user.principal, on.tables[table]!, "all");
    }
    return user;
  };

  const ask = async (
    token: string,
    on: SeededSource,
    body: Record<string, unknown>
  ): Promise<JsonResponse> => {
    const res = await postQuery(token, { source: on.slug, ...body });
    if (res.status !== 200) errorBodies.push(res.body);
    return res;
  };

  beforeAll(async () => {
    source = await seedQuerySource(engine);
    quick = await seedQuerySource(engine, { timeout_ms: 1000 });
    capped = await seedQuerySource(engine, { row_cap: 3 });
  });
  afterAll(async () => {
    await removeRunsOf(users);
    await removeSources([source.id, quick.id, capped.id]);
  });

  it("stops a query past the source's time limit with 504 query_timeout", async () => {
    const user = await grantedUser(quick);
    const begun = Date.now();
    const res = await ask(user.token, quick, {
      from: "slow_orders",
      select: ["id"],
    });
    expect(res.status).toBe(504);
    expect(res.body).toEqual({
      error: "query_timeout",
      error_description: "The query ran past its time limit",
      request_id: expect.any(String),
    });
    expect(Date.now() - begun).toBeLessThan(2900);
    expect(await engine.runningOn("slow_orders")).toBe(0);
  });

  it("answers a failing query with 502 query_failed and a fixed message", async () => {
    const user = await grantedUser(source);
    const res = await ask(user.token, source, {
      from: "broken_orders",
      select: ["ratio"],
    });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({
      error: "query_failed",
      error_description: "The source could not run the query",
      request_id: expect.any(String),
    });
  });

  it("returns `limit` rows and says more existed", async () => {
    const user = await grantedUser(source);
    const res = await ask(user.token, source, {
      from: "orders",
      select: ["id"],
      limit: 5,
    });
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([[1], [2], [3], [4], [5]]);
    expect(res.body.truncated).toBe(true);
    expect(res.body.truncated_by).toBe("rows");
  });

  it("clamps a limit above the maximum and reports truncation only when more rows existed", async () => {
    const user = await grantedUser(source);
    const res = await ask(user.token, source, {
      from: "orders",
      select: ["id"],
      limit: 1_000_000,
    });
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(12);
    expect(res.body.truncated).toBe(false);
  });

  it("holds every query to the source's row cap", async () => {
    const user = await grantedUser(capped);
    for (const limit of [undefined, 10]) {
      const res = await ask(user.token, capped, {
        from: "orders",
        select: ["id"],
        ...(limit && { limit }),
      });
      expect(res.status).toBe(200);
      expect(res.body.rows).toEqual([[1], [2], [3]]);
      expect(res.body.truncated).toBe(true);
      expect(res.body.truncated_by).toBe("rows");
    }
    const under = await ask(user.token, capped, {
      from: "orders",
      select: ["id"],
      limit: 2,
    });
    expect(under.body.rows).toEqual([[1], [2]]);
  });

  it("runs two queries at once per user, refuses a third with 429 too_many_queries, and frees the slots", async () => {
    const user = await grantedUser(source);
    const slow = () =>
      ask(user.token, source, { from: "slow_orders", select: ["id"] });
    const results = await Promise.all([slow(), slow(), slow()]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 429]);
    const refused = results.find((r) => r.status === 429)!;
    expect(refused.body).toEqual({
      error: "too_many_queries",
      error_description: expect.any(String),
      retry_after: 1,
      request_id: expect.any(String),
    });
    const fourth = await ask(user.token, source, {
      from: "orders",
      select: ["id"],
      limit: 1,
    });
    expect(fourth.status).toBe(200);
  });

  it("sends Retry-After with a refusal", async () => {
    const user = await grantedUser(source);
    const slow = () =>
      fetch(`${BASE_URL}/v1/query`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${user.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          source: source.slug,
          from: "slow_orders",
          select: ["id"],
        }),
      });
    const responses = await Promise.all([slow(), slow(), slow()]);
    const refused = responses.find((r) => r.status === 429)!;
    expect(refused.headers.get("retry-after")).toBe("1");
    await Promise.all(responses.map((r) => r.text()));
  });

  it("runs five queries at once per source and refuses a sixth with 429 source_busy", async () => {
    const callers = await Promise.all(
      Array.from({ length: 6 }, () => grantedUser(source))
    );
    const results = await Promise.all(
      callers.map((user) =>
        ask(user.token, source, { from: "slow_orders", select: ["id"] })
      )
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    expect(results.find((r) => r.status === 429)!.body.error).toBe(
      "source_busy"
    );
    expect(
      (
        await ask(callers[0]!.token, source, {
          from: "orders",
          select: ["id"],
          limit: 1,
        })
      ).status
    ).toBe(200);
  });

  it("refuses a body over 64 KB with 413 payload_too_large", async () => {
    const user = await grantedUser(source);
    const res = await ask(user.token, source, {
      from: "orders",
      select: ["id"],
      where: {
        status: { in: Array.from({ length: 1000 }, () => "x".repeat(70)) },
      },
    });
    expect(res.status).toBe(413);
    expect(res.body.error).toBe("payload_too_large");
  });

  it("puts no database or driver text in any error body", () => {
    expect(errorBodies.length).toBeGreaterThan(4);
    for (const body of errorBodies) {
      expect(JSON.stringify(body)).not.toMatch(DRIVER_TEXT);
    }
  });
});
