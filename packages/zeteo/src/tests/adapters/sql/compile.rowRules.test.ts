// @module-tag int
// @module-tag platform
import { AzureSqlPreparedQuery } from "../../../adapters/azure-sql/runQuery.js";
import { PostgresPreparedQuery } from "../../../adapters/postgres/runQuery.js";
import type { SourceConnection, SourceType } from "../../../adapters/types.js";
import { postgresDialect } from "../../../adapters/sql/dialects/postgres.js";
import { fixtureSettings, fixtureTarget } from "../../support/fixtureDb.js";
import { buildVisibleCatalog } from "../../../grants/visibleCatalog.js";
import type { VisibleCatalog } from "../../../grants/visibleCatalog.js";
import { mssqlDialect } from "../../../adapters/sql/dialects/mssql.js";
import { initializeTereo, stopTereo } from "../../../utils/tereo.js";
import { sqlQuerySchema } from "../../../adapters/sql/language.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CALENDAR } from "../../../calendar/calendar.js";
import { sealSettings } from "../../../utils/crypto/envelope.js";
import { closeAllSourcePools } from "../../../sources/pools.js";
import { compileSql } from "../../../adapters/sql/compile.js";
import type { SqlPlan } from "../../../adapters/sql/types.js";
import type { RowRule } from "../../../row-rules/resolve.js";
import { refreshSource } from "../../../catalog/refresh.js";
import { adapterFor } from "../../../adapters/index.js";
import { planSql } from "../../../adapters/sql/plan.js";
import { runPrepared } from "../../support/runPlan.js";
import { prisma } from "../../../utils/db/prisma.js";
import { db } from "../../../utils/db/index.js";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import {
  mssqlFixtureSettings,
  mssqlFixtureTarget,
  mssqlSourceSettings,
} from "../../support/mssqlFixture.js";
import {
  removeSources,
  sourceSettings,
  uniqueSlug,
} from "../../support/sources.js";

// A condition of the caller's that cannot raise an error on any row is
// applied beside the row rule, inside the rule's read, so an index can serve
// it. The rows a query returns must be the same either way: every query
// below runs with its conditions beside the rule and with every condition
// outside it, on both engines, and the two results are compared. Conditions
// that must stay outside (a value that is not the column's own type) are
// mixed in, and the compiled SQL shows where each went.

const ENGINES = [
  {
    name: "postgres",
    type: "postgres" as SourceType,
    prismaType: "postgres",
    dialect: postgresDialect,
    settings: () => sourceSettings("ro"),
    connectSettings: () => fixtureSettings("ro"),
    target: fixtureTarget,
    prepared: (plan: SqlPlan, sql: string, parameters: unknown[]) =>
      new PostgresPreparedQuery(plan, sql, parameters),
  },
  {
    name: "azure-sql",
    type: "azure-sql" as SourceType,
    prismaType: "azure_sql",
    dialect: mssqlDialect,
    settings: () => mssqlSourceSettings("ro"),
    connectSettings: () => mssqlFixtureSettings("ro"),
    target: mssqlFixtureTarget,
    prepared: (plan: SqlPlan, sql: string, parameters: unknown[]) =>
      new AzureSqlPreparedQuery(
        plan,
        sql,
        parameters as ConstructorParameters<typeof AzureSqlPreparedQuery>[2]
      ),
  },
] as const;

/** Conditions on `orders`: some move beside the rule, some cannot. */
const ORDER_CONDITIONS: object[] = [
  { id: { eq: 6 } },
  { id: { ne: 3 } },
  { id: { gt: 4 } },
  { id: { lte: 9 } },
  { id: { in: [1, 3, 6, 11, 40] } },
  { id: { notIn: [2, 11] } },
  { id: { between: [3, 10] } },
  { id: { eq: "1" + "0".repeat(30) } },
  { id: { ne: "2.5" } },
  { id: { lt: "7.5" } },
  { customer_id: { eq: 2 } },
  { customer_id: { gt: "1.5" } },
  { customer_id: { in: [1, 3] } },
  { total: { gt: "50" } },
  { total: { lte: "99.99" } },
  { total: { eq: "75" } },
  { total: { gt: "18.399" } },
  { total: { between: ["10.5", "500.25"] } },
  { total: { lt: 1e-7 } },
  { status: { eq: "paid" } },
  { status: { ne: "shipped" } },
  { status: { in: ["paid", "cancelled"] } },
  { status: { startsWith: "sh" } },
  { status: { contains: "AI" } },
  { notes: { isNull: true } },
  { notes: { isNull: false } },
  { notes: { contains: "_" } },
  { notes: { eq: "Call First" } },
  { notes: { gt: "end" } },
  { created_at: { gte: "2026-03-01T00:00:00Z" } },
  { created_at: { lt: "2026-04-01T00:00:00+02:00" } },
  { created_at: { gte: "2026-03-31T23:59:59.999Z" } },
  { created_at: { lt: "2026-06-10T10:10:10.5000001Z" } },
  { created_at: { gt: "2026-06-10T10:10:10.123456789Z" } },
  { created_at: { between: ["2026-01-01T00:00:00Z", "2026-05-01T00:00:00Z"] } },
  { external_ref: { gt: 5 } },
  { external_ref: { eq: "9007199254740993" } },
  { external_ref: { isNull: true } },
  { external_ref: { lt: "1" + "0".repeat(25) } },
  { or: [{ id: { eq: 6 } }, { status: { eq: "shipped" } }] },
  { not: { status: { eq: "paid" } } },
];

/** Deterministic pairs: every condition alone, then a spread of pairs. */
const pairs = (conditions: object[]): object[] => {
  const out: object[] = conditions.map((c) => c);
  for (let i = 0; i < conditions.length; i++) {
    for (let j = i + 1; j < conditions.length; j += 7) {
      out.push({ and: [conditions[i], conditions[j]] });
    }
  }
  return out;
};

const QUERIES: object[] = [
  ...pairs(ORDER_CONDITIONS).map((where) => ({
    from: "orders",
    select: ["id", "status", "total"],
    where,
  })),
  { from: "orders", select: [{ count: "*" }] },
  { from: "orders", select: [{ count: "*" }], where: { id: { gt: 4 } } },
  {
    from: "orders",
    select: ["status", { sum: "total", as: "s" }],
    where: { total: { gt: "10" } },
    groupBy: ["status"],
  },
  ...(["inner", "left"] as const).flatMap((type) =>
    [
      { "orders.id": { gt: 4 } },
      { "orders.status": { eq: "paid" } },
      { name: { startsWith: "M" } },
      { region: { eq: "EU" }, "orders.total": { gt: "50" } },
      { "orders.notes": { isNull: true } },
      { "orders.id": { isNull: true } },
    ].map((where) => ({
      from: "customers",
      join: [{ relation: "orders", type }],
      select: ["id", "name", "orders.id"],
      where,
    }))
  ),
  {
    from: "orders",
    join: [{ relation: "customers", type: "inner" }],
    select: ["id", "customers.name"],
    where: { "customers.region": { eq: "EU" }, id: { lt: 10 } },
  },
];

const ruleOn = (
  columns: {
    id: string;
    tableId: string;
    name: string;
    type: string;
    nativeType: string;
  }[],
  table: string,
  column: string,
  filter: object
): RowRule => {
  const c = columns.find((x) => x.tableId === table && x.name === column)!;
  return {
    kind: "filter",
    filter: { [c.id]: filter },
    columns: new Map([
      [
        c.id,
        {
          id: c.id,
          name: c.name,
          type: c.type as "text",
          nativeType: c.nativeType,
        },
      ],
    ]),
    descriptions: [],
  } as RowRule;
};

for (const engine of ENGINES) {
  describe(`conditions beside a row rule return the same rows (${engine.name})`, () => {
    const sourceId = randomUUID();
    let catalog: VisibleCatalog;
    let conn: SourceConnection;

    beforeAll(async () => {
      await initializeTereo();
      await prisma.source.create({
        data: {
          id: sourceId,
          slug: uniqueSlug("rrpush"),
          name: "Row rule push-down",
          type: engine.prismaType,
          sealedSettings: sealSettings(engine.settings(), sourceId) as object,
          schemas: ["sales"],
          createdBy: randomUUID(),
        },
      });
      await refreshSource(sourceId, randomUUID());
      const source = (await db.sources.findById(sourceId))!;
      const { tables, columns, relations } =
        await db.catalog.loadSourceCatalog(sourceId);
      const id = (name: string) => tables.find((t) => t.name === name)!.id;
      const rules = new Map([
        [
          id("orders"),
          ruleOn(columns, id("orders"), "status", {
            in: ["paid", "shipped"],
          }),
        ],
        [
          id("customers"),
          ruleOn(columns, id("customers"), "region", { eq: "EU" }),
        ],
      ]);
      catalog = buildVisibleCatalog(
        source,
        tables,
        columns,
        relations,
        {
          sourceIds: new Set([sourceId]),
          allows: () => true,
          tableAccess: () => "all",
          rowRule: (tableId: string) => rules.get(tableId),
        },
        { calendar: DEFAULT_CALENDAR, measures: [] }
      );
      conn = await adapterFor(engine.type).connect(
        engine.connectSettings() as never,
        await engine.target(),
        { connectTimeoutMs: 5000, poolSize: 2, queryTimeoutMs: 10_000 }
      );
    });
    afterAll(async () => {
      await conn?.close();
      await closeAllSourcePools();
      await removeSources([sourceId]);
      await stopTereo();
    });

    const run = async (plan: SqlPlan, pushDown: boolean) => {
      const { sql, parameters } = compileSql(
        plan,
        engine.dialect,
        { limit: 1001, offset: 0 },
        { pushDown }
      );
      const result = await runPrepared(
        conn,
        engine.prepared(plan, sql, parameters),
        {
          maxRows: 1000,
          maxBytes: 10 * 1024 * 1024,
          timeoutMs: 10_000,
          deadlineAt: performance.now() + 10_000,
        }
      );
      const rows = result.rows.map((r) => JSON.stringify(r)).sort();
      return { sql, rows };
    };

    it(`returns the same rows for ${QUERIES.length} queries with and without conditions beside the rule`, async () => {
      let moved = 0;
      const differing: unknown[] = [];
      for (const query of QUERIES) {
        const plan = planSql(
          sqlQuerySchema.parse({ source: catalog.source.slug, ...query }),
          catalog
        );
        const beside = await run(plan, true);
        const outside = await run(plan, false);
        if (beside.sql !== outside.sql) moved++;
        if (JSON.stringify(beside.rows) !== JSON.stringify(outside.rows)) {
          differing.push({ query, beside: beside.rows, outside: outside.rows });
        }
      }
      expect(differing).toEqual([]);
      // Most queries move something beside the rule; the test would prove
      // little if none did.
      expect(moved).toBeGreaterThan(QUERIES.length / 2);
    });

    it("keeps conditions whose values are not the column's own type outside the rule's read", () => {
      const read = (where: object) => {
        const { sql } = compileSql(
          planSql(
            sqlQuerySchema.parse({
              source: catalog.source.slug,
              from: "orders",
              select: ["id"],
              where,
            }),
            catalog
          ),
          engine.dialect,
          { limit: 101, offset: 0 }
        );
        return engine.name === "postgres"
          ? /materialized \((select .*?)\) select \* from "r"/.exec(sql)![1]!
          : /select [^;]*? into #r0 from [^;]*;/.exec(sql)![0];
      };
      const outside: object[] = [
        { customer_id: { gt: "1.5" } },
        { id: { lt: "1" + "0".repeat(30) } },
        { or: [{ id: { eq: 6 } }, { id: { eq: 7 } }] },
        { not: { id: { eq: 6 } } },
        ...(engine.name === "postgres"
          ? [{ status: { startsWith: "p" } }, { notes: { contains: "x" } }]
          : [
              { total: { gt: "18.399" } },
              { total: { lt: 1e-7 } },
              { created_at: { gt: "2026-06-10T10:10:10.123456789Z" } },
            ]),
      ];
      for (const where of outside) {
        expect({ where, read: read(where) }).toEqual({
          where,
          read: expect.stringMatching(
            engine.name === "postgres"
              ? /where "status" = ANY\(\$1\)$|where "status" in \(\$1, \$2\)$/
              : // After the rule's guard (`ruleGuard`), which binds @1.
                /where \[status\] in \(@2, @3\);$/
          ),
        });
      }
      for (const where of [
        { id: { eq: 6 } },
        { customer_id: { in: [1, 3] } },
        { total: { gt: "50" } },
        { created_at: { gte: "2026-03-01T00:00:00Z" } },
        { notes: { isNull: true } },
        ...(engine.name === "postgres"
          ? []
          : [{ status: { startsWith: "p" } }]),
      ]) {
        expect({ where, read: read(where) }).toEqual({
          where,
          read: expect.stringMatching(/\) and /),
        });
      }
    });
  });
}
