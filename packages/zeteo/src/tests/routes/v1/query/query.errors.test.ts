// @module-tag int
// @module-tag platform
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { closeAllSourcePools } from "../../../../sources/pools.js";
import { describeEachEngine } from "../../../support/engines.js";
import { removeSources } from "../../../support/sources.js";
import { adapterFor } from "../../../../adapters/index.js";
import { startV1Routes } from "../../../support/v1App.js";
import type {
  QueryResult,
  SourceConnection,
} from "../../../../adapters/types.js";
import {
  grantTo,
  newQueryUser,
  postQuery,
  removeRunsOf,
  runsOf,
  seedQuerySource,
  type SeededSource,
} from "../../../support/queries.js";

// The engine's own checks against a planner or adapter that misbehaves, made
// to misbehave in this process: what the result goes through on its way out,
// and what the plan references.
const tamper = vi.hoisted(() => ({
  result: undefined as ((r: QueryResult) => QueryResult) | undefined,
}));

vi.mock(import("../../../../sources/pools.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    withSourceConnection: <T>(
      id: string,
      fn: (conn: SourceConnection) => Promise<T>
    ) =>
      actual.withSourceConnection(id, (conn) =>
        fn({
          ...conn,
          checkLogin: () => conn.checkLogin(),
          readSchema: (s) => conn.readSchema(s),
          close: () => conn.close(),
          runQuery: async (plan, limits, signal) => {
            const result = await conn.runQuery(plan, limits, signal);
            return tamper.result ? tamper.result(result) : result;
          },
        })
      ),
  };
});

describeEachEngine("POST /v1/query: the engine's checks", (engine) => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  let source: SeededSource;
  const user = newQueryUser();

  const ask = () =>
    postQuery(
      user.token,
      { source: source.slug, from: "accounts", select: ["id", "name"] },
      app.url
    );

  beforeAll(async () => {
    app = await startV1Routes();
    source = await seedQuerySource(engine);
    await grantTo(user.principal, source.tables.accounts!, ["id", "name"]);
  });
  afterEach(() => {
    tamper.result = undefined;
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await closeAllSourcePools();
    await app.close();
    await removeRunsOf([user.id]);
    await removeSources([source.id]);
  });

  it("answers normally when nothing is tampered with", async () => {
    const res = await ask();
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([
      [1, "Northwind"],
      [2, "Contoso"],
    ]);
  });

  it.each([
    [
      "a column renamed",
      (r: QueryResult) => ({
        ...r,
        columns: [r.columns[0]!, { name: "plan", type: "text" as const }],
      }),
    ],
    [
      "a column retyped",
      (r: QueryResult) => ({
        ...r,
        columns: [r.columns[0]!, { name: "name", type: "json" as const }],
      }),
    ],
    [
      "an extra column",
      (r: QueryResult) => ({
        ...r,
        columns: [...r.columns, { name: "plan", type: "text" as const }],
      }),
    ],
    [
      "a row wider than the columns",
      (r: QueryResult) => ({
        ...r,
        rows: r.rows.map((row) => [...row, "enterprise"]),
      }),
    ],
  ])(
    "refuses a result with %s: 502 query_failed, no rows, recorded as failed",
    async (_, change) => {
      tamper.result = change;
      const res = await ask();
      expect(res.status).toBe(502);
      expect(res.body).toEqual({
        error: "query_failed",
        error_description: "The source could not run the query",
      });
      expect(JSON.stringify(res.body)).not.toMatch(/Northwind|enterprise/);
      const run = (await runsOf([user.id])).at(-1)!;
      expect(run).toMatchObject({
        outcome: "failed",
        errorCode: "query_failed",
      });
    }
  );

  it("refuses a plan that references an ungranted column as not_found_or_not_accessible", async () => {
    const { language } = adapterFor(engine.type);
    const plan = language.plan.bind(language);
    const accounts = source.tables.accounts!;
    vi.spyOn(language, "plan").mockImplementation((query, catalog) => {
      const planned = plan(query, catalog);
      return {
        ...planned,
        references: [
          ...planned.references,
          { tableId: accounts.id, columnId: accounts.columns.plan! },
        ],
      };
    });
    const res = await ask();
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("not_found_or_not_accessible");
    expect(JSON.stringify(res.body)).not.toContain("plan");
    const run = (await runsOf([user.id])).at(-1)!;
    expect(run).toMatchObject({
      outcome: "refused",
      errorCode: "not_found_or_not_accessible",
    });
  });
});
