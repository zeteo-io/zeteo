// @module-tag int
// @module-tag platform
import { auditRows, removeSources } from "../../../support/sources.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeAllSourcePools } from "../../../../sources/pools.js";
import { describeEachEngine } from "../../../support/engines.js";
import { startV1Routes } from "../../../support/v1App.js";
import { recordRun } from "../../../../engine/record.js";
import { BASE_URL } from "../../../support/http.js";
import {
  grantTo,
  newQueryUser,
  postQuery,
  removeRunsOf,
  runsOf,
  seedQuerySource,
  type SeededSource,
} from "../../../support/queries.js";

// The recorder as the engine sees it, failing only when a test says so.
vi.mock(import("../../../../engine/record.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, recordRun: vi.fn(actual.recordRun) };
});

const waitFor = async <T>(
  check: () => Promise<T | undefined>,
  ms = 5000
): Promise<T> => {
  const until = Date.now() + ms;
  for (;;) {
    const found = await check();
    if (found !== undefined) return found;
    if (Date.now() > until) throw new Error("never seen");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

describeEachEngine("POST /v1/query: the run record", (engine) => {
  let source: SeededSource;
  let quick: SeededSource;
  const users: string[] = [];

  const grantedUser = async () => {
    const user = newQueryUser();
    users.push(user.id);
    for (const on of [source, quick]) {
      for (const table of ["accounts", "slow_orders"]) {
        await grantTo(user.principal, on.tables[table]!, "all");
      }
    }
    return user;
  };

  /** The one run of `userId`, with its one audit entry. */
  const onlyRunOf = async (userId: string) => {
    const runs = await runsOf([userId]);
    expect(runs).toHaveLength(1);
    const audit = await auditRows(runs[0]!.id);
    expect(audit).toHaveLength(1);
    return { run: runs[0]!, audit: audit[0]!.payload };
  };

  beforeAll(async () => {
    source = await seedQuerySource(engine);
    quick = await seedQuerySource(engine, { timeout_ms: 1000 });
  });
  afterAll(async () => {
    await removeRunsOf(users);
    await removeSources([source.id, quick.id]);
  });

  it("records a success: the run and its audit entry, and none of the rows", async () => {
    const user = await grantedUser();
    const body = {
      source: source.slug,
      from: "accounts",
      select: ["id", "name"],
      limit: 1,
    };
    const res = await postQuery(user.token, body);
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([[1, "Northwind"]]);

    const { run, audit } = await onlyRunOf(user.id);
    expect(run).toMatchObject({
      id: res.body.run_id,
      userId: user.id,
      sourceId: source.id,
      entryPoint: "api",
      query: body,
      rowCount: 1,
      outcome: "ok",
      errorCode: null,
      truncated: true,
    });
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
    expect(audit).toMatchObject({
      action: "CREATE",
      entityType: "query_run",
      entityId: run.id,
      userId: user.id,
      metadata: {
        event: "zeteo.query.run",
        source_id: source.id,
        entry_point: "api",
        outcome: "ok",
        error_code: null,
        row_count: 1,
        duration_ms: run.durationMs,
      },
    });
    expect(Object.keys(audit.metadata).sort()).toEqual([
      "duration_ms",
      "entry_point",
      "error_code",
      "event",
      "outcome",
      "row_count",
      "source_id",
    ]);
    expect(JSON.stringify([run, audit])).not.toContain("Northwind");
  });

  it("records a refusal with its code", async () => {
    const user = await grantedUser();
    const res = await postQuery(user.token, {
      source: source.slug,
      from: "accounts",
      select: ["nope"],
    });
    expect(res.status).toBe(422);
    const { run, audit } = await onlyRunOf(user.id);
    expect(run).toMatchObject({
      sourceId: source.id,
      outcome: "refused",
      errorCode: "not_found_or_not_accessible",
      rowCount: null,
      truncated: false,
    });
    expect(audit.metadata).toMatchObject({
      outcome: "refused",
      error_code: "not_found_or_not_accessible",
      row_count: null,
    });
  });

  it("records a refusal for a source the caller cannot see, with no source", async () => {
    const user = await grantedUser();
    const body = { source: "invented-zzqxw", from: "accounts", select: ["id"] };
    expect((await postQuery(user.token, body)).status).toBe(422);
    const { run, audit } = await onlyRunOf(user.id);
    expect(run).toMatchObject({
      sourceId: null,
      query: body,
      outcome: "refused",
      errorCode: "not_found_or_not_accessible",
    });
    expect(audit.metadata).toMatchObject({ source_id: null });
  });

  it("records a timeout", async () => {
    const user = await grantedUser();
    const res = await postQuery(user.token, {
      source: quick.slug,
      from: "slow_orders",
      select: ["id"],
    });
    expect(res.status).toBe(504);
    const { run, audit } = await onlyRunOf(user.id);
    expect(run).toMatchObject({
      sourceId: quick.id,
      outcome: "timeout",
      errorCode: "query_timeout",
    });
    expect(audit.metadata).toMatchObject({
      outcome: "timeout",
      error_code: "query_timeout",
    });
  });

  it("records nothing for a body that fails the shape check", async () => {
    const user = await grantedUser();
    for (const body of [
      { from: "accounts", select: ["id"] },
      { source: source.slug, from: "accounts", select: [] },
    ]) {
      expect((await postQuery(user.token, body)).status).toBe(400);
    }
    expect(await runsOf([user.id])).toEqual([]);
  });

  it("records a run the client abandoned as client_closed, and stops it on the source", async () => {
    const user = await grantedUser();
    const controller = new AbortController();
    const sent = fetch(`${BASE_URL}/v1/query`, {
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
      signal: controller.signal,
    }).catch((err: unknown) => err);
    await waitFor(async () =>
      (await engine.runningOn("slow_orders")) > 0 ? true : undefined
    );
    const aborted = Date.now();
    controller.abort();
    expect(await sent).toBeInstanceOf(Error);

    const [run] = await waitFor(async () => {
      const runs = await runsOf([user.id]);
      return runs.length > 0 ? runs : undefined;
    });
    expect(run).toMatchObject({
      sourceId: source.id,
      outcome: "failed",
      errorCode: "client_closed",
      rowCount: null,
    });
    // slow_orders takes three seconds: it was stopped, not left to finish.
    expect(Date.now() - aborted).toBeLessThan(2500);
    expect(await engine.runningOn("slow_orders")).toBe(0);
    expect(await auditRows(run!.id)).toHaveLength(1);
  });

  describe("when the record cannot be written", () => {
    let app: Awaited<ReturnType<typeof startV1Routes>>;
    beforeAll(async () => {
      app = await startV1Routes();
    });
    afterAll(async () => {
      await closeAllSourcePools();
      await app.close();
    });

    it("fails a successful query with 500 and sends none of its rows", async () => {
      const user = await grantedUser();
      vi.mocked(recordRun).mockRejectedValueOnce(new Error("disk full"));
      const res = await postQuery(
        user.token,
        { source: source.slug, from: "accounts", select: ["id", "name"] },
        app.url
      );
      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        error: "server_error",
        error_description: "An unexpected error occurred",
      });
      expect(await runsOf([user.id])).toEqual([]);
    });

    it("keeps a failed query's own error", async () => {
      const user = await grantedUser();
      vi.mocked(recordRun).mockRejectedValueOnce(new Error("disk full"));
      const res = await postQuery(
        user.token,
        { source: source.slug, from: "accounts", select: ["nope"] },
        app.url
      );
      expect(res.status).toBe(422);
      expect(res.body.error).toBe("not_found_or_not_accessible");
    });

    it("records through the same seam when it works", async () => {
      const user = await grantedUser();
      const res = await postQuery(
        user.token,
        { source: source.slug, from: "accounts", select: ["id"] },
        app.url
      );
      expect(res.status).toBe(200);
      expect((await onlyRunOf(user.id)).run.id).toBe(res.body.run_id);
    });
  });
});
