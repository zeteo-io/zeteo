// @module-tag int
// @module-tag platform
import { closeAllSourcePools } from "../../sources/pools.js";
import { describeEachEngine } from "../support/engines.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { removeSources } from "../support/sources.js";
import { prisma } from "../../utils/db/index.js";
import { randomUUID } from "node:crypto";
import {
  grantTo,
  newQueryUser,
  postQuery,
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../support/queries.js";

// A calculation the caller writes must never be evaluated on a row their row
// rule hides: if it can fail there (an overflow, a date out of range), a
// failed request against a successful one tells the caller something about
// rows they cannot see. In the fixture, the caller limited to shipped orders
// sees orders 3, 7 and 11 (external_ref 1, null and 9). Hidden paid order 6
// has external_ref 123456789012 and notes "end of quarter"; hidden order 4
// has notes "gift wrap".

/** `id` multiplied by itself twenty times: overflows for any id above 8. */
const ID_TO_THE_20 = {
  mul: [
    { mul: Array.from({ length: 10 }, () => "id") },
    { mul: Array.from({ length: 10 }, () => "id") },
  ],
};

describeEachEngine("row rules, errors on hidden rows", (engine) => {
  let source: SeededSource;
  const one = newQueryUser();
  const many = newQueryUser();
  const ident = newQueryUser();
  const users = [one, many, ident];
  const keyIds: string[] = [];

  beforeAll(async () => {
    source = await seedQuerySource(engine, {}, "rrerrors");
    const { orders } = source.tables;
    await grantTo(one.principal, orders!, "all", {
      access: "rule",
      rule: { status: { eq: "shipped" } },
    });
    await grantTo(many.principal, orders!, "all", {
      access: "rule",
      rule: {
        status: { in: ["shipped", "a", "b", "c", "d", "e", "f", "g"] },
      },
    });
    const key = await prisma.identityKey.create({
      data: {
        name: `st_${randomUUID().slice(0, 8)}`,
        label: "Status",
        createdBy: one.id,
      },
    });
    keyIds.push(key.id);
    await prisma.identityValue.createMany({
      data: ["shipped", ...Array.from({ length: 199 }, (_, i) => `s${i}`)].map(
        (value) => ({
          keyId: key.id,
          userId: ident.id,
          value,
          createdBy: one.id,
        })
      ),
    });
    await grantTo(ident.principal, orders!, "all", {
      access: "rule",
      rule: { status: { in: { identity: key.name } } },
    });
  });
  afterAll(async () => {
    await removeRunsOf(users.map((u) => u.id));
    await removeSources([source.id]);
    await prisma.identityValue.deleteMany({ where: { keyId: { in: keyIds } } });
    await prisma.identityKey.deleteMany({ where: { id: { in: keyIds } } });
    await closeAllSourcePools();
  });

  const run = async (token: string, body: Record<string, unknown>) => {
    const res = await postQuery(token, {
      source: source.slug,
      from: "orders",
      ...body,
    });
    return {
      status: res.status,
      ids:
        res.status === 200
          ? (res.body.rows as unknown[][]).map((r) => Number(r[0])).sort()
          : (res.body as { error?: string }).error,
    };
  };

  for (const [label, user] of [
    ["one value", one],
    ["eight literals", many],
    ["200 identity values", ident],
  ] as const) {
    it(`a where calculation that overflows only on hidden rows succeeds (${label})`, async () => {
      expect(
        await run(user.token, {
          select: [
            "id",
            { calc: { mul: ["external_ref", "external_ref"] }, as: "sq" },
          ],
          where: { sq: { gt: 0 } },
        })
      ).toEqual({ status: 200, ids: [11, 3] });
    });

    it(`a hidden row's value cannot be bisected (${label})`, async () => {
      // 123456789012 * 80,000,000 overflows a bigint; 70,000,000 does not.
      for (const hidden of [5, 6]) {
        for (const k of [70_000_000, 80_000_000]) {
          expect(
            await run(user.token, {
              select: ["id", { calc: { mul: ["external_ref", k] }, as: "p" }],
              where: { and: [{ p: { gt: 0 } }, { id: { eq: hidden } }] },
            })
          ).toEqual({ status: 200, ids: [] });
        }
      }
    });

    it(`a hidden row's text cannot be guessed through case (${label})`, async () => {
      for (const guess of ["end of quarter", "nope", "gift wrap"]) {
        const calc = {
          case: {
            when: [{ if: { notes: { eq: guess } }, then: ID_TO_THE_20 }],
            else: 0,
          },
        };
        // Alone, and beside a cheap filter Postgres would run first.
        for (const extra of [[], [{ notes: { startsWith: guess[0] } }]]) {
          expect(
            await run(user.token, {
              select: ["id", { calc, as: "p" }],
              where: { and: [{ p: { gt: 0 } }, ...extra] },
            })
          ).toEqual({ status: 200, ids: [] });
        }
      }
    });

    it(`select, order by and aggregates never read hidden rows (${label})`, async () => {
      const sq = { mul: ["external_ref", "external_ref"] };
      expect(
        await run(user.token, {
          select: ["id", { calc: sq, as: "sq" }],
          orderBy: [{ sq: "desc" }],
        })
      ).toMatchObject({ status: 200 });
      expect(
        await run(user.token, {
          select: [{ sum: sq, as: "total" }],
        })
      ).toMatchObject({ status: 200 });
    });
  }
});
