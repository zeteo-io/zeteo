// @module-tag int
// @module-tag platform
import { initializeTereo, stopTereo } from "../../utils/tereo.js";
import { DATA_READ } from "../../definitions/tereoDeclaration.js";
import { closeAllSourcePools } from "../../sources/pools.js";
import { describeEachEngine } from "../support/engines.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Caller } from "../../middleware/auth.js";
import { removeSources } from "../support/sources.js";
import { db, prisma } from "../../utils/db/index.js";
import { runQuery } from "../../engine/index.js";
import { randomUUID } from "node:crypto";
import {
  grantTo,
  newQueryUser,
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../support/queries.js";

// Fixed measures on both engines: each is a scalar subquery over its own
// table, so it reads the same whatever query it is in, and the query's other
// columns read exactly as they would without it.

const SHIPPED = { status: { eq: "shipped" } };
/** The fixture's latest shipped order: order 11. */
const LAST_SHIPPED = "2026-06-10T10:10:10.5Z";

describeEachEngine("runQuery: fixed measures", (engine) => {
  const user = newQueryUser();
  const caller: Caller = {
    userId: user.id,
    organizationId: null,
    permissions: [DATA_READ],
    isServiceAccount: false,
  };
  const author = randomUUID();
  let source: SeededSource;
  /** The stored measures that are fixed, until the column exists. */
  const fixedNames = new Set<string>();
  const listBySource = db.measures.listBySource;

  const addMeasure = async (
    name: string,
    table: string,
    formula: object,
    where: object | null = null,
    fixed = false
  ) => {
    await prisma.measure.create({
      data: {
        sourceId: source.id,
        tableId: source.tables[table]!.id,
        name,
        description: `The ${name}`,
        formula,
        ...(where ? { where } : {}),
        createdBy: author,
        updatedBy: author,
      },
    });
    if (fixed) fixedNames.add(name);
  };

  const run = async (from: string, select: unknown[], extra: object = {}) =>
    (
      await runQuery({
        caller,
        entryPoint: "api",
        body: { source: source.slug, from, select, ...extra },
      })
    ).rows;

  beforeAll(async () => {
    await initializeTereo();
    db.measures = {
      ...db.measures,
      listBySource: async (sourceId: string) =>
        (await listBySource(sourceId)).map((row) => ({
          ...row,
          fixed: fixedNames.has(row.name),
        })),
    };
    source = await seedQuerySource(engine, {}, "fixed");
    for (const table of ["orders", "customers", "accounts", "order_lines"]) {
      await grantTo(user.principal, source.tables[table]!, "all");
    }
    // The shape of "last actuals month" and "Forecast (Open)".
    await addMeasure(
      "last_shipped_at",
      "orders",
      { max: "created_at" },
      SHIPPED,
      true
    );
    await addMeasure(
      "open_revenue",
      "orders",
      { sum: "total" },
      {
        created_at: { gt: { measure: "last_shipped_at" } },
      }
    );
    await addMeasure("line_count", "order_lines", { count: "*" }, null, true);
    await addMeasure("scaled_revenue", "orders", {
      sum: { mul: ["total", { measure: "line_count" }] },
    });
  });
  afterAll(async () => {
    db.measures = { ...db.measures, listBySource };
    await removeRunsOf([user.id]);
    await removeSources([source.id]);
    await closeAllSourcePools();
    await stopTereo();
  });

  it("sums only what comes after the fixed measure, leaving the plain sum beside it as it was", async () => {
    const [[plain]] = (await run("orders", [{ sum: "total", as: "s" }])) as [
      [unknown],
    ];
    const [[handFiltered]] = (await run("orders", [{ sum: "total", as: "s" }], {
      where: { created_at: { gt: LAST_SHIPPED } },
    })) as [[unknown]];
    const [row] = await run("orders", [
      { sum: "total", as: "s" },
      { measure: "open_revenue" },
    ]);
    expect(Number(row![0])).toBe(Number(plain));
    expect(Number(row![1])).toBe(Number(handFiltered));
    expect(Number(row![1])).toBe(999.99);

    // Per group as well: the fixed value is the whole table's, not the group's.
    const grouped = await run(
      "orders",
      ["status", { sum: "total", as: "s" }, { measure: "open_revenue" }],
      { groupBy: ["status"], orderBy: [{ status: "asc" }] }
    );
    const plainGrouped = await run(
      "orders",
      ["status", { sum: "total", as: "s" }],
      { groupBy: ["status"], orderBy: [{ status: "asc" }] }
    );
    expect(grouped.map((r) => [r[0], Number(r[1])])).toEqual(
      plainGrouped.map((r) => [r[0], Number(r[1])])
    );
    expect(
      grouped.map((r) => [r[0], r[2] === null ? null : Number(r[2])])
    ).toEqual(plainGrouped.map((r) => [r[0], r[0] === "paid" ? 999.99 : null]));
  });

  it("reads the same one value from another table, alone or beside a group", async () => {
    const alone = await run("customers", [{ measure: "line_count" }]);
    expect(alone.map((r) => Number(r[0]))).toEqual([2]);
    const byRegion = await run(
      "customers",
      ["region", { count: "*", as: "n" }, { measure: "line_count" }],
      { groupBy: ["region"], orderBy: [{ region: "asc" }] }
    );
    expect(byRegion.map((r) => [r[0], Number(r[1]), Number(r[2])])).toEqual([
      ["EU", 2, 2],
      ["US", 1, 2],
    ]);
  });

  it("gives one row with its value when the query's where matches no row", async () => {
    const none = await run("customers", [{ measure: "line_count" }], {
      where: { region: { eq: "nowhere" } },
    });
    expect(none.map((r) => Number(r[0]))).toEqual([2]);
    const [[at]] = (await run("orders", [{ measure: "last_shipped_at" }], {
      where: { id: { lt: 0 } },
    })) as [[unknown]];
    expect(new Date(at as string).toISOString()).toBe(
      new Date(LAST_SHIPPED).toISOString()
    );
  });

  it("works inside an aggregate and in a row-level calc", async () => {
    const [[sum, scaled]] = (await run("orders", [
      { sum: "total", as: "s" },
      { measure: "scaled_revenue" },
    ])) as [[unknown, unknown]];
    expect(Number(scaled)).toBeCloseTo(2 * Number(sum), 2);

    const rows = await run(
      "orders",
      ["id", { calc: { sub: ["total", { measure: "line_count" }] }, as: "x" }],
      { where: { id: { lte: 2 } }, orderBy: [{ id: "asc" }] }
    );
    expect(rows.map((r) => [Number(r[0]), Number(r[1])])).toEqual([
      [1, 8],
      [2, 248.5],
    ]);
  });

  it("is a comparison value in where, and ignores the query's joins and filters", async () => {
    const after = await run("orders", ["id"], {
      where: { created_at: { gt: { measure: "last_shipped_at" } } },
    });
    expect(after.map((r) => Number(r[0]))).toEqual([12]);
    // A to-many join and a filter excluding every shipped order change nothing.
    const joined = await run(
      "orders",
      [{ count: "order_lines.qty", as: "n" }, { measure: "line_count" }],
      { join: ["order_lines"], where: { status: { eq: "paid" } } }
    );
    expect(joined.map((r) => [Number(r[0]), Number(r[1])])).toEqual([[2, 2]]);
  });
});
