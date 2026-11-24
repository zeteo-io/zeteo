// @module-tag int
// @module-tag platform
import { postgresDialect } from "../../../adapters/sql/dialects/postgres.js";
import { buildVisibleCatalog } from "../../../grants/visibleCatalog.js";
import type { VisibleCatalog } from "../../../grants/visibleCatalog.js";
import { initializeTereo, stopTereo } from "../../../utils/tereo.js";
import { sqlQuerySchema } from "../../../adapters/sql/language.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CALENDAR } from "../../../calendar/calendar.js";
import { sealSettings } from "../../../utils/crypto/envelope.js";
import { compileSql } from "../../../adapters/sql/compile.js";
import type { RowRule } from "../../../row-rules/resolve.js";
import { fixtureSettings } from "../../support/fixtureDb.js";
import { refreshSource } from "../../../catalog/refresh.js";
import { planSql } from "../../../adapters/sql/plan.js";
import { prisma } from "../../../utils/db/prisma.js";
import { db } from "../../../utils/db/index.js";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import {
  removeSources,
  sourceSettings,
  uniqueSlug,
} from "../../support/sources.js";

// A table with a row rule is read through a MATERIALIZED WITH query, which
// the PostgreSQL documentation says is computed separately from the query
// around it: the caller's conditions are applied to its output, never on the
// table beside the rule, where Postgres would order them by cost. The shape
// of the plan pins it, so a planner that saw through it would fail here.

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "CTE Name"?: string;
  "Subplan Name"?: string;
  Filter?: string;
  "Join Filter"?: string;
  "Index Cond"?: string;
  Plans?: PlanNode[];
}

const nodes = (node: PlanNode): PlanNode[] => [
  node,
  ...(node.Plans ?? []).flatMap(nodes),
];

describe("row rules on Postgres: the plan", () => {
  const sourceId = randomUUID();
  let catalog: VisibleCatalog;
  let client: Client;

  beforeAll(async () => {
    await initializeTereo();
    await prisma.source.create({
      data: {
        id: sourceId,
        slug: uniqueSlug("rrplan"),
        name: "Row rule plans",
        type: "postgres",
        sealedSettings: sealSettings(sourceSettings("ro"), sourceId) as object,
        schemas: ["sales"],
        createdBy: randomUUID(),
      },
    });
    await refreshSource(sourceId, randomUUID());
    const source = (await db.sources.findById(sourceId))!;
    const { tables, columns, relations } =
      await db.catalog.loadSourceCatalog(sourceId);
    const orders = tables.find((t) => t.name === "orders")!;
    const status = columns.find(
      (c) => c.tableId === orders.id && c.name === "status"
    )!;
    const rule: RowRule = {
      kind: "filter",
      filter: { [status.id]: { in: ["shipped", "a", "b", "c", "d"] } },
      columns: new Map([
        [
          status.id,
          {
            id: status.id,
            name: status.name,
            type: status.type as "text",
            nativeType: status.nativeType,
          },
        ],
      ]),
      descriptions: [],
    } as RowRule;
    catalog = buildVisibleCatalog(
      source,
      tables,
      columns,
      relations,
      {
        sourceIds: new Set([sourceId]),
        allows: () => true,
        tableAccess: () => "all",
        rowRule: (tableId: string) =>
          tableId === orders.id ? rule : undefined,
      },
      { calendar: DEFAULT_CALENDAR, measures: [] }
    );
    client = new Client({ ...fixtureSettings("ro"), ssl: false });
    await client.connect();
  });
  afterAll(async () => {
    await client?.end();
    await removeSources([sourceId]);
    await stopTereo();
  });

  const explain = async (query: object): Promise<PlanNode[]> => {
    const { sql, parameters } = compileSql(
      planSql(
        sqlQuerySchema.parse({ source: catalog.source.slug, ...query }),
        catalog
      ),
      postgresDialect,
      { limit: 101, offset: 0 }
    );
    const { rows } = await client.query<{ "QUERY PLAN": [{ Plan: PlanNode }] }>(
      `explain (format json) ${sql}`,
      parameters
    );
    return nodes(rows[0]!["QUERY PLAN"][0].Plan);
  };

  /** The caller's calculation, on `external_ref`; the rule's condition, on `status`. */
  const callerFilter = (n: PlanNode) =>
    `${n.Filter ?? ""} ${n["Join Filter"] ?? ""} ${n["Index Cond"] ?? ""}`.includes(
      "external_ref"
    );

  it("applies the caller's where to the rule's output, never beside the rule", async () => {
    const plan = await explain({
      from: "orders",
      select: [
        "id",
        { calc: { mul: ["external_ref", "external_ref"] }, as: "sq" },
      ],
      where: { and: [{ sq: { gt: 0 } }, { id: { eq: 6 } }] },
    });
    const scans = plan.filter((n) => n["Relation Name"] === "orders");
    expect(scans.length).toBeGreaterThan(0);
    for (const scan of scans) {
      expect(scan.Filter ?? "").toContain("status");
      expect(callerFilter(scan)).toBe(false);
      // `id = 6` cannot raise: it is applied beside the rule, through the
      // primary key's index.
      expect(`${scan["Index Cond"] ?? ""} ${scan.Filter ?? ""}`).toContain(
        "id = 6"
      );
    }
    const reads = plan.filter((n) => n["Node Type"] === "CTE Scan");
    expect(reads).toHaveLength(1);
    expect(callerFilter(reads[0]!)).toBe(true);
  });

  it("keeps the rule's read apart from the caller's conditions when nothing moves beside it", async () => {
    const plan = await explain({
      from: "orders",
      select: [
        "id",
        { calc: { mul: ["external_ref", "external_ref"] }, as: "sq" },
      ],
      where: {
        or: [{ sq: { gt: 0 } }, { id: { eq: 6 } }],
      },
    });
    for (const scan of plan.filter((n) => n["Relation Name"] === "orders")) {
      expect(scan.Filter ?? "").toContain("status");
      expect(callerFilter(scan)).toBe(false);
      expect(scan["Node Type"]).not.toMatch(/Index/);
    }
    const reads = plan.filter((n) => n["Node Type"] === "CTE Scan");
    expect(reads).toHaveLength(1);
    expect(callerFilter(reads[0]!)).toBe(true);
  });

  it("keeps the rule apart from a join's conditions", async () => {
    const plan = await explain({
      from: "customers",
      join: [{ relation: "orders", type: "inner" }],
      select: [
        "name",
        { calc: { mul: ["orders.external_ref", 80_000_000] }, as: "p" },
      ],
      where: { p: { gt: 0 } },
    });
    for (const scan of plan.filter((n) => n["Relation Name"] === "orders")) {
      expect(callerFilter(scan)).toBe(false);
    }
    expect(plan.some((n) => n["Node Type"] === "CTE Scan")).toBe(true);
  });
});
