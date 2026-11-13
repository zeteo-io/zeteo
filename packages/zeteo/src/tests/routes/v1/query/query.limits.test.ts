// @module-tag int
// @module-tag platform
// @module-tag slow
import { clearTestGroups, setTestGroups } from "../../../support/principals.js";
import { initializeTereo, stopTereo } from "../../../../utils/tereo.js";
import { DATA_READ } from "../../../../definitions/tereoDeclaration.js";
import { removeSources, writeToken } from "../../../support/sources.js";
import { describeEachEngine } from "../../../support/engines.js";
import { grantsWriteToken } from "../../../support/grants.js";
import type { Caller } from "../../../../middleware/auth.js";
import type { JsonResponse } from "../../../support/http.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { runQuery } from "../../../../engine/index.js";
import { fetchJson } from "../../../support/http.js";
import { BASE_URL } from "../../../support/http.js";
import env from "../../../../env.js";
import { randomUUID } from "crypto";
import {
  removePrincipalLimits,
  setPrincipalLimit,
} from "../../../support/principalLimits.js";
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

/** The highest `query_concurrency` a source takes. */
const MAX_SOURCE_QUERY_CONCURRENCY = 50;

describeEachEngine("POST /v1/query: limits", (engine) => {
  let source: SeededSource;
  let quick: SeededSource;
  let capped: SeededSource;
  /** Over the portable tables and the probe schema's wide rows. */
  let wide: SeededSource;
  /** Runs one query at a time. */
  let single: SeededSource;
  /** Runs six queries at once. */
  let six: SeededSource;
  /** Runs more queries at once than one user may. */
  let roomy: { source: SeededSource; queryConcurrency: number };
  const extra: string[] = [];
  const users: string[] = [];
  /** Principals given their own limits. */
  const limited: string[] = [];
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
    wide = await seedQuerySource(engine, {
      schemas: [...engine.schemas, "probe"],
    });
    single = await seedQuerySource(engine, { query_concurrency: 1 });
    six = await seedQuerySource(engine, { query_concurrency: 6 });
    const queryConcurrency = Math.min(
      env.USER_QUERY_CONCURRENCY + 2,
      MAX_SOURCE_QUERY_CONCURRENCY
    );
    roomy = {
      source: await seedQuerySource(engine, {
        query_concurrency: queryConcurrency,
      }),
      queryConcurrency,
    };
    await initializeTereo();
  });
  afterAll(async () => {
    await stopTereo();
    await removePrincipalLimits(limited);
    for (const id of users) await clearTestGroups(id);
    await removeRunsOf(users);
    await removeSources([
      source.id,
      quick.id,
      capped.id,
      wide.id,
      single.id,
      six.id,
      roomy.source.id,
      ...extra,
    ]);
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

  const slowQuery = (token: string, on: SeededSource) =>
    ask(token, on, { from: "slow_orders", select: ["id"] });

  it("runs USER_QUERY_CONCURRENCY queries at once per user, refuses one more with 429 too_many_queries, and frees the slots", async ({
    skip,
  }) => {
    const perUser = env.USER_QUERY_CONCURRENCY;
    // The user's limit is reached only on a source that runs more at once.
    skip(
      perUser >= MAX_SOURCE_QUERY_CONCURRENCY,
      `USER_QUERY_CONCURRENCY is ${perUser}; this test needs it below ${MAX_SOURCE_QUERY_CONCURRENCY}, a source's highest query_concurrency`
    );
    expect(roomy.queryConcurrency).toBeGreaterThan(perUser);
    const user = await grantedUser(roomy.source);
    const results = await Promise.all(
      Array.from({ length: perUser + 1 }, () =>
        slowQuery(user.token, roomy.source)
      )
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([...Array(perUser).fill(200), 429]);
    const refused = results.find((r) => r.status === 429)!;
    expect(refused.body).toEqual({
      error: "too_many_queries",
      error_description: `At most ${perUser} queries may run at once for one user`,
      retry_after: 1,
      request_id: expect.any(String),
    });
    const after = await ask(user.token, roomy.source, {
      from: "orders",
      select: ["id"],
      limit: 1,
    });
    expect(after.status).toBe(200);
  });

  it("refuses a user's second query with too_many_queries when their limit is 1", async () => {
    const user = await grantedUser(roomy.source);
    const caller: Caller = {
      userId: user.id,
      organizationId: null,
      permissions: [DATA_READ],
      isServiceAccount: false,
    };
    const run = () =>
      runQuery({
        caller,
        entryPoint: "api",
        body: {
          source: roomy.source.slug,
          from: "slow_orders",
          select: ["id"],
        },
        userLimits: { queryConcurrency: 1, exportConcurrency: 1 },
      });
    const results = await Promise.allSettled([run(), run()]);
    expect(results.map((r) => r.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    const refused = results.find((r) => r.status === "rejected")!;
    expect((refused as PromiseRejectedResult).reason).toMatchObject({
      statusCode: 429,
      code: "too_many_queries",
      message: "At most 1 query may run at once for one user",
    });
  });

  it("holds a user to their group's query_concurrency 1, and lets a user with their own row of 3 run three", async () => {
    const groupId = randomUUID();
    limited.push(groupId);
    await setPrincipalLimit(
      { type: "group", id: groupId },
      { query_concurrency: 1 }
    );
    const member = await grantedUser(roomy.source);
    await setTestGroups(member.id, [{ id: groupId, organizationId: null }]);
    const memberRuns = await Promise.all([
      slowQuery(member.token, roomy.source),
      slowQuery(member.token, roomy.source),
    ]);
    expect(memberRuns.map((r) => r.status).sort()).toEqual([200, 429]);
    expect(memberRuns.find((r) => r.status === 429)!.body).toMatchObject({
      error: "too_many_queries",
      error_description: "At most 1 query may run at once for one user",
    });

    const own = await grantedUser(roomy.source);
    limited.push(own.id);
    await setPrincipalLimit(
      { type: "user", id: own.id },
      { query_concurrency: 3 }
    );
    const ownRuns = await Promise.all(
      Array.from({ length: 4 }, () => slowQuery(own.token, roomy.source))
    );
    expect(ownRuns.map((r) => r.status).sort()).toEqual([200, 200, 200, 429]);
    expect(ownRuns.find((r) => r.status === 429)!.body).toMatchObject({
      error: "too_many_queries",
      error_description: "At most 3 queries may run at once for one user",
    });
  });

  it("holds a service account to its own row, and applies a change to the runs that start after it", async () => {
    const id = randomUUID();
    users.push(id);
    limited.push(id);
    await grantTo(
      { type: "user", id },
      roomy.source.tables.slow_orders!,
      "all"
    );
    const token = `test-token-${id}|client=${id}|perms=${DATA_READ}`;
    const limitId = await setPrincipalLimit(
      { type: "user", id },
      { query_concurrency: 1 }
    );
    const twice = () =>
      Promise.all([
        slowQuery(token, roomy.source),
        slowQuery(token, roomy.source),
      ]);
    expect((await twice()).map((r) => r.status).sort()).toEqual([200, 429]);
    const patched = await fetchJson(
      "PATCH",
      `${BASE_URL}/v1/principal-limits/${limitId}`,
      grantsWriteToken(),
      { query_concurrency: 2 }
    );
    expect(patched.status).toBe(200);
    expect((await twice()).map((r) => r.status)).toEqual([200, 200]);
  });

  it("refuses a second query on a source with query_concurrency 1 from another user with 429 source_busy and Retry-After", async () => {
    const [first, second] = await Promise.all([
      grantedUser(single),
      grantedUser(single),
    ]);
    const slow = (token: string) =>
      fetch(`${BASE_URL}/v1/query`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          source: single.slug,
          from: "slow_orders",
          select: ["id"],
        }),
      });
    const responses = await Promise.all([
      slow(first!.token),
      slow(second!.token),
    ]);
    const bodies = await Promise.all(responses.map((r) => r.json()));
    expect(responses.map((r) => r.status).sort()).toEqual([200, 429]);
    const at = responses.findIndex((r) => r.status === 429);
    expect(responses[at]!.headers.get("retry-after")).toBe("1");
    expect(bodies[at]).toMatchObject({
      error: "source_busy",
      error_description:
        "The source runs at most 1 query at once; retry shortly",
    });
    errorBodies.push(bodies[at]);
  });

  it("runs six queries at once on a source with query_concurrency 6 and refuses a seventh with 429 source_busy", async () => {
    const callers = await Promise.all(
      Array.from({ length: 7 }, () => grantedUser(six))
    );
    const results = await Promise.all(
      callers.map((user) => slowQuery(user.token, six))
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 429]);
    expect(results.find((r) => r.status === 429)!.body).toMatchObject({
      error: "source_busy",
      error_description:
        "The source runs at most 6 queries at once; retry shortly",
    });
    expect(
      (
        await ask(callers[0]!.token, six, {
          from: "orders",
          select: ["id"],
          limit: 1,
        })
      ).status
    ).toBe(200);
  });

  it("applies a changed query_concurrency to the runs that start after it", async () => {
    const changing = await seedQuerySource(engine, { query_concurrency: 1 });
    extra.push(changing.id);
    const [first, second] = await Promise.all([
      grantedUser(changing),
      grantedUser(changing),
    ]);
    const twice = () =>
      Promise.all([
        slowQuery(first!.token, changing),
        slowQuery(second!.token, changing),
      ]);
    expect((await twice()).map((r) => r.status).sort()).toEqual([200, 429]);
    const patched = await fetchJson(
      "PATCH",
      `${BASE_URL}/v1/sources/${changing.id}`,
      writeToken(),
      { query_concurrency: 2 }
    );
    expect(patched.status).toBe(200);
    expect((await twice()).map((r) => r.status)).toEqual([200, 200]);
  });

  it("stops at the 10 MB size limit with truncated_by bytes, the body under it", async () => {
    const user = newQueryUser();
    users.push(user.id);
    await grantTo(user.principal, wide.tables.wide_rows!, "all");
    const res = await ask(user.token, wide, {
      from: "wide_rows",
      select: ["id", "filler"],
      orderBy: [{ id: "asc" }],
      limit: 50_000,
    });
    expect(res.status).toBe(200);
    expect(res.body.truncated).toBe(true);
    expect(res.body.truncated_by).toBe("bytes");
    const rows = res.body.rows as [number, string][];
    // 2 KB rows: about 5,000 fit 10 MB, far fewer than the 60,000 there are.
    expect(rows.length).toBeGreaterThan(4000);
    expect(rows.length).toBeLessThan(6000);
    expect(rows.map(([id]) => id)).toEqual(
      Array.from({ length: rows.length }, (_, i) => i + 1)
    );
    expect(Buffer.byteLength(JSON.stringify(rows))).toBeLessThanOrEqual(
      10 * 1024 * 1024
    );
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
