// @module-tag int
// @module-tag platform
import { closeAllSourcePools } from "../../sources/pools.js";
import { describeEachEngine } from "../support/engines.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { removeSources } from "../support/sources.js";
import { prisma } from "../../utils/db/index.js";
import {
  grantTo,
  newQueryUser,
  postQuery,
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../support/queries.js";

// SQL Server takes no subquery inside an aggregate: an `in` of more than 100
// values binds as one list (a subquery there) only in a clause of its own;
// inside a case (aggregated, or a measure's where) it keeps a parameter per
// value. Both engines run it, and must agree.

/** 150 ids, orders 6 to 12 among them. */
const IDS = Array.from({ length: 150 }, (_, i) => i + 6);

describeEachEngine("runQuery: long in lists", (engine) => {
  let source: SeededSource;
  const user = newQueryUser();

  const ok = async (body: Record<string, unknown>) => {
    const res = await postQuery(user.token, { source: source.slug, ...body });
    if (res.status !== 200) {
      throw new Error(`${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body.rows as unknown[][];
  };
  /** The sum of `total` of orders 6 to 12, by status, as a plain where gives it. */
  const expected = async () =>
    ok({
      from: "orders",
      select: ["status", { sum: "total", as: "s" }],
      where: { id: { gte: 6 } },
      groupBy: ["status"],
      orderBy: [{ status: "asc" }],
    });
  const asNumbers = (rows: unknown[][]) =>
    rows.map(([k, v]) => [k, v === null ? null : Number(v)]);

  beforeAll(async () => {
    source = await seedQuerySource(engine, {}, "inlists");
    await grantTo(user.principal, source.tables.orders!, "all");
    await prisma.measure.create({
      data: {
        sourceId: source.id,
        tableId: source.tables.orders!.id,
        name: "picked_total",
        description: "Total of the picked orders",
        formula: { sum: "total" },
        where: { id: { in: IDS } },
        createdBy: user.id,
        updatedBy: user.id,
      },
    });
  });
  afterAll(async () => {
    await removeRunsOf([user.id]);
    await removeSources([source.id]);
    await closeAllSourcePools();
  });

  it("filters where by 150 values", async () => {
    const rows = await ok({
      from: "orders",
      select: ["id"],
      where: { id: { in: IDS } },
    });
    expect(rows.map((r) => Number(r[0])).sort((a, b) => a - b)).toEqual([
      6, 7, 8, 9, 10, 11, 12,
    ]);
  });

  it("sums a case of 150 in values, grouped", async () => {
    const rows = await ok({
      from: "orders",
      select: [
        "status",
        {
          sum: {
            case: {
              when: [{ if: { id: { in: IDS } }, then: "total" }],
            },
          },
          as: "s",
        },
      ],
      groupBy: ["status"],
      orderBy: [{ status: "asc" }],
    });
    const want = await expected();
    // A status with no picked order sums nothing: null.
    expect(asNumbers(rows).filter(([, v]) => v !== null)).toEqual(
      asNumbers(want)
    );
  });

  it("runs a measure whose where has 150 in values", async () => {
    const rows = await ok({
      from: "orders",
      select: ["status", { measure: "picked_total" }],
      groupBy: ["status"],
      orderBy: [{ status: "asc" }],
    });
    const want = await expected();
    expect(asNumbers(rows).filter(([, v]) => v !== null)).toEqual(
      asNumbers(want)
    );
  });
});
