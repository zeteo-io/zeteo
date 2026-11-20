// @module-tag int
// @module-tag platform
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { SavedQueryNotAccessibleError } from "../../utils/errors.js";
import { initializeTereo, stopTereo } from "../../utils/tereo.js";
import { DATA_READ } from "../../definitions/tereoDeclaration.js";
import { closeAllSourcePools } from "../../sources/pools.js";
import { describeEachEngine } from "../support/engines.js";
import type { Caller } from "../../middleware/auth.js";
import { removeSources } from "../support/sources.js";
import { prisma } from "../../utils/db/prisma.js";
import { runQuery } from "../../engine/index.js";
import { randomUUID } from "node:crypto";
import {
  grantTo,
  newQueryUser,
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../support/queries.js";

const THIS_YEAR = { relative: { unit: "year", offset: 0, startOf: true } };
const PAID = { status: { eq: "paid" } };

describeEachEngine("runQuery: measures", (engine) => {
  const user = newQueryUser();
  const caller: Caller = {
    userId: user.id,
    organizationId: null,
    permissions: [DATA_READ],
    isServiceAccount: false,
  };
  const author = randomUUID();
  let source: SeededSource;

  const addMeasure = (
    name: string,
    formula: object,
    where: object | null = null
  ) =>
    prisma.measure.create({
      data: {
        sourceId: source.id,
        tableId: source.tables.orders!.id,
        name,
        description: `The ${name}`,
        formula,
        ...(where ? { where } : {}),
        createdBy: author,
        updatedBy: author,
      },
    });

  const run = (select: unknown[], extra: object = {}) =>
    runQuery({
      caller,
      entryPoint: "api",
      body: { source: source.slug, from: "orders", select, ...extra },
    });

  beforeAll(async () => {
    await initializeTereo();
    source = await seedQuerySource(engine, {}, "measures");
    for (const table of ["orders", "customers", "accounts"]) {
      await grantTo(user.principal, source.tables[table]!, "all");
    }
    await addMeasure("total_revenue", { sum: "total" });
    await addMeasure("paid_revenue", { measure: "total_revenue" }, PAID);
    await addMeasure(
      "paid_ytd",
      { measure: "paid_revenue" },
      { created_at: { gte: THIS_YEAR } }
    );
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  afterAll(async () => {
    await removeRunsOf([user.id]);
    await removeSources([source.id]);
    await closeAllSourcePools();
    await stopTereo();
  });

  it("returns a measure per group and leaves the plain aggregate beside it as it was", async () => {
    const plain = await run(["customers.region", { sum: "total", as: "s" }], {
      join: ["customers"],
      groupBy: ["customers.region"],
      orderBy: [{ "customers.region": "asc" }],
    });
    const withMeasure = await run(
      [
        "customers.region",
        { sum: "total", as: "s" },
        { measure: "paid_revenue" },
      ],
      {
        join: ["customers"],
        groupBy: ["customers.region"],
        orderBy: [{ "customers.region": "asc" }],
      }
    );
    const paid = await run(["customers.region", { sum: "total", as: "p" }], {
      join: ["customers"],
      where: PAID,
      groupBy: ["customers.region"],
      orderBy: [{ "customers.region": "asc" }],
    });
    expect(withMeasure.columns.map((c) => c.name)).toEqual([
      "customers.region",
      "s",
      "paid_revenue",
    ]);
    // `s` is the same with the measure beside it as without it.
    expect(withMeasure.rows.map((r) => [r[0], Number(r[1])])).toEqual(
      plain.rows.map((r) => [r[0], Number(r[1])])
    );
    // `paid_revenue` is the sum of the paid orders per region.
    expect(withMeasure.rows.map((r) => [r[0], Number(r[2])])).toEqual(
      paid.rows.map((r) => [r[0], Number(r[1])])
    );
    expect(Number(withMeasure.rows[0]![2])).not.toBe(
      Number(withMeasure.rows[0]![1])
    );
  });

  it("reads paid_ytd as this year's paid total only", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T12:00:00Z"));
    const thisYear = await run([{ measure: "paid_ytd" }]);
    const allPaid = await run([{ sum: "total" }], { where: PAID });
    expect(Number(thisYear.rows[0]![0])).toBe(Number(allPaid.rows[0]![0]));
    expect(Number(thisYear.rows[0]![0])).toBeGreaterThan(0);

    // A year on, none of the fixture's 2026 orders count.
    vi.setSystemTime(new Date("2027-03-01T12:00:00Z"));
    const nextYear = await run([{ measure: "paid_ytd" }]);
    expect(nextYear.rows[0]![0] ?? 0).toBe(0);
  });

  it("runs a saved query using a measure, and refuses it as not accessible once the measure is deleted", async () => {
    const query = {
      source: source.slug,
      from: "orders",
      select: [{ measure: "paid_revenue" }],
    };
    const saved = await prisma.savedQuery.create({
      data: {
        ownerId: user.id,
        sourceId: source.id,
        name: `measures ${randomUUID().slice(0, 8)}`,
        query,
      },
    });
    const savedQuery = { id: saved.id, sourceId: source.id };
    const ran = await runQuery({
      caller,
      entryPoint: "api",
      body: query,
      savedQuery,
    });
    expect(Number(ran.rows[0]![0])).toBeGreaterThan(0);

    await prisma.measure.deleteMany({
      where: { sourceId: source.id, name: "paid_ytd" },
    });
    await prisma.measure.deleteMany({
      where: { sourceId: source.id, name: "paid_revenue" },
    });
    const failure = await runQuery({
      caller,
      entryPoint: "api",
      body: query,
      savedQuery,
    }).catch((err: unknown) => err);
    // A saved query's planning failure is always this one answer, whatever the cause.
    expect(failure).toBeInstanceOf(SavedQueryNotAccessibleError);
  });
});
