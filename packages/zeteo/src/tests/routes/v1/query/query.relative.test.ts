// @module-tag int
// @module-tag platform
import { describeEachEngine } from "../../../support/engines.js";
import { removeSources } from "../../../support/sources.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  grantTo,
  newQueryUser,
  postQuery,
  removeRunsOf,
  runsOf,
  seedQuerySource,
  type SeededSource,
} from "../../../support/queries.js";

// The fixture's orders are dated early 2026.

describeEachEngine("POST /v1/query: relative dates", (engine) => {
  let source: SeededSource;
  const user = newQueryUser();

  const count = async (where: object) => {
    const res = await postQuery(user.token, {
      source: source.slug,
      from: "orders",
      select: [{ count: "*", as: "orders" }],
      where,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return Number(res.body.rows[0][0]);
  };

  beforeAll(async () => {
    source = await seedQuerySource(engine, {}, "relative");
    await grantTo(user.principal, source.tables.orders!, "all");
  });
  afterAll(async () => {
    await removeRunsOf([user.id]);
    await removeSources([source.id]);
  });

  it("returns what a fixed-date query for the same window returns", async () => {
    const day = 86_400_000;
    const windows = [
      { unit: "day", offset: -7, ms: 7 * day },
      { unit: "week", offset: -52 * 10, ms: 520 * 7 * day },
    ] as const;
    for (const { unit, offset, ms } of windows) {
      const relative = { relative: { unit, offset } };
      const fixed = new Date(Date.now() - ms).toISOString();
      for (const op of ["gte", "lt"]) {
        // The two moments are seconds apart and no fixture row sits between.
        expect(await count({ created_at: { [op]: relative } })).toBe(
          await count({ created_at: { [op]: fixed } })
        );
      }
    }
    // The fixture's orders are all older than a week and newer than ten years.
    expect(
      await count({
        created_at: { gte: { relative: { unit: "week", offset: -520 } } },
      })
    ).toBeGreaterThan(0);
  });

  it("records the relative JSON as sent", async () => {
    const where = {
      created_at: {
        gte: { relative: { unit: "month", offset: -1, startOf: true } },
      },
    };
    await count(where);
    const runs = await runsOf([user.id]);
    const last = runs[runs.length - 1]!;
    expect((last.query as { where: unknown }).where).toEqual(where);
  });
});
