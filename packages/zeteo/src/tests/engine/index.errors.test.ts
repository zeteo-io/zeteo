// @module-tag int
// @module-tag platform
import { ndjsonLines, newExportUser, postExport } from "../support/exports.js";
import { describeEachEngine, type EngineFixture } from "../support/engines.js";
import { fixtureAdminSettings } from "../support/fixtureDb.js";
import { closeAllSourcePools } from "../../sources/pools.js";
import { asMssqlAdmin } from "../support/mssqlFixture.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { removeSources } from "../support/sources.js";
import { prisma } from "../../utils/db/index.js";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
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
  const exporter = newExportUser();
  const users = [one, many, ident, exporter];
  const keyIds: string[] = [];
  const author = randomUUID();

  beforeAll(async () => {
    source = await seedQuerySource(
      engine,
      { export_enabled: true, export_row_cap: 1000 },
      "rrerrors"
    );
    const { orders, customers } = source.tables;
    for (const u of users) await grantTo(u.principal, customers!, "all");
    await grantTo(exporter.principal, orders!, "all", {
      access: "rule",
      rule: {
        status: { in: ["shipped", "a", "b", "c", "d", "e", "f", "g"] },
      },
    });
    // Each overflows a bigint on hidden order 6 (external_ref
    // 123456789012), and on no row the callers see.
    for (const [name, fixed] of [
      ["fx_ext", true],
      ["m_ext", false],
    ] as const) {
      await prisma.measure.create({
        data: {
          sourceId: source.id,
          tableId: orders!.id,
          name,
          description: `The ${name}`,
          formula: { max: { mul: ["external_ref", 80_000_000] } },
          fixed,
          dateColumn: fixed ? null : "created_at",
          createdBy: author,
          updatedBy: author,
        },
      });
    }
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
    await prisma.measure.deleteMany({ where: { sourceId: source.id } });
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

    it(`a joined ruled table cannot be bisected, inner or left (${label})`, async () => {
      for (const type of ["inner", "left"]) {
        for (const hidden of [5, 6]) {
          for (const k of [70_000_000, 80_000_000]) {
            const res = await postQuery(user.token, {
              source: source.slug,
              from: "customers",
              join: [{ relation: "orders", type }],
              select: [
                "id",
                { calc: { mul: ["orders.external_ref", k] }, as: "p" },
              ],
              where: {
                and: [{ p: { gt: 0 } }, { "orders.id": { eq: hidden } }],
              },
            });
            expect({ type, hidden, k, status: res.status }).toEqual({
              type,
              hidden,
              k,
              status: 200,
            });
            expect(res.body.rows).toEqual([]);
          }
        }
      }
    });

    it(`a fixed measure and a metric part never read hidden rows (${label})`, async () => {
      for (const body of [
        {
          from: "customers",
          select: ["name", { measure: "fx_ext" }],
          groupBy: ["name"],
        },
        { from: "orders", select: [{ measure: "fx_ext" }] },
        {
          from: "customers",
          select: ["id"],
          where: { id: { lt: { measure: "fx_ext" } } },
        },
        { metrics: ["m_ext"], bucket: "month" },
        {
          metrics: ["m_ext", "fx_ext"],
          bucket: "month",
          range: {
            gte: { timestamp: "2026-01-01T00:00:00Z" },
            lt: { timestamp: "2027-01-01T00:00:00Z" },
          },
        },
      ]) {
        const res = await postQuery(user.token, {
          source: source.slug,
          ...body,
        });
        expect({ body, status: res.status }).toEqual({ body, status: 200 });
      }
    });

    it(`conditions that stay outside the rule's read raise nothing on hidden rows (${label})`, async () => {
      const sq = { calc: { mul: ["external_ref", "external_ref"] }, as: "sq" };
      for (const [condition, ids] of [
        [{ customer_id: { gt: "1.5" } }, [11, 3]],
        [{ notes: { contains: "x" } }, []],
        [{ id: { lt: "1" + "0".repeat(30) } }, [11, 3]],
        [{ created_at: { gte: "2026-01-01T00:00:00.123456789Z" } }, [11, 3]],
        [{ total: { gt: "0.001" } }, [11, 3]],
        [{ status: { ne: "paid" } }, [11, 3]],
        [{ or: [{ id: { eq: 6 } }, { id: { eq: 3 } }] }, [3]],
        [{ not: { id: { eq: 6 } } }, [11, 3]],
      ] as const) {
        expect({
          condition,
          ...(await run(user.token, {
            select: ["id", sq],
            where: { and: [{ sq: { gt: 0 } }, condition] },
          })),
        }).toEqual({ condition, status: 200, ids });
      }
    });
  }

  it("an export never reads hidden rows", async () => {
    for (const where of [
      { p: { gt: 0 } },
      { and: [{ p: { gt: 0 } }, { id: { eq: 6 } }] },
    ]) {
      const res = await postExport({
        token: exporter.token,
        body: {
          source: source.slug,
          from: "orders",
          select: [
            "id",
            { calc: { mul: ["external_ref", 80_000_000] }, as: "p" },
          ],
          where,
        },
      });
      expect(res.status).toBe(200);
      const lines = ndjsonLines(res.text);
      const expected = "and" in where ? [] : [11, 3];
      expect(lines.at(-1)).toEqual({
        status: "complete",
        rows: expected.length,
      });
      const ids = lines.slice(1, -1).map((r) => Number((r as unknown[])[0]));
      expect(ids.sort()).toEqual(expected);
    }
  });
});

// Differential probes: one query asked of a hidden row's id, of an id no row
// has and of a visible row's id, with a condition that would raise if it were
// evaluated on a row. The hidden and the missing id must get the same answer:
// any difference reads the hidden row. Each table is the test's own, in
// schema rr_probe, dropped before and after.
const PROBE_SCHEMA = "rr_probe";

const asProbeAdmin = async (
  engine: EngineFixture,
  statements: { postgres: string[]; mssql: string[] }
): Promise<void> => {
  if (engine.type === "azure-sql") {
    await asMssqlAdmin(statements.mssql);
    return;
  }
  const admin = new Client({ ...fixtureAdminSettings(), ssl: false });
  await admin.connect();
  try {
    for (const statement of statements.postgres) await admin.query(statement);
  } finally {
    await admin.end();
  }
};

/** A hidden row's id, an id no row has, a visible row's id. */
const HIDDEN = 6;
const NOWHERE = 99;
const VISIBLE = 1;

describeEachEngine(
  "row rules, differential probes on hidden rows",
  (engine) => {
    let source: SeededSource;
    const shown = newQueryUser();
    const stale = newQueryUser();
    const users = [shown, stale];
    const drop = {
      postgres: [`DROP SCHEMA IF EXISTS ${PROBE_SCHEMA} CASCADE`],
      mssql: [
        `DROP TABLE IF EXISTS ${PROBE_SCHEMA}.items`,
        `DROP SCHEMA IF EXISTS ${PROBE_SCHEMA}`,
      ],
    };

    beforeAll(async () => {
      await asProbeAdmin(engine, drop);
      await asProbeAdmin(engine, {
        postgres: [
          `CREATE SCHEMA ${PROBE_SCHEMA}`,
          `CREATE COLLATION ${PROBE_SCHEMA}.ci (provider = icu, locale = 'und-u-ks-level2', deterministic = false)`,
          `CREATE TABLE ${PROBE_SCHEMA}.items (id integer PRIMARY KEY, status text NOT NULL, ref uuid, stamp timestamp(3), label text COLLATE ${PROBE_SCHEMA}.ci, code integer)`,
          `INSERT INTO ${PROBE_SCHEMA}.items VALUES
           (1, 'shown', '6f1c1b2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b', '2026-02-01 00:00:00', 'Alpha', 1),
           (2, 'shown', NULL, '2026-03-01 00:00:00', 'Beta', 2),
           (3, 'shown', NULL, '2026-03-02 00:00:00', 'Delta', 150),
           (6, 'hidden', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', '2026-04-01 00:00:00', 'Gamma', 6)`,
          `GRANT USAGE ON SCHEMA ${PROBE_SCHEMA} TO zeteo_ro`,
          `GRANT SELECT ON ${PROBE_SCHEMA}.items TO zeteo_ro`,
        ],
        mssql: [
          `CREATE SCHEMA ${PROBE_SCHEMA}`,
          `CREATE TABLE ${PROBE_SCHEMA}.items (id int NOT NULL PRIMARY KEY, status nvarchar(20) NOT NULL, ref uniqueidentifier, stamp datetime2(3), label nvarchar(50), code int)`,
          `INSERT INTO ${PROBE_SCHEMA}.items VALUES
           (1, N'shown', '6F1C1B2E-3C4D-4E5F-8A9B-0C1D2E3F4A5B', '2026-02-01 00:00:00', N'Alpha', 1),
           (2, N'shown', NULL, '2026-03-01 00:00:00', N'Beta', 2),
           (3, N'shown', NULL, '2026-03-02 00:00:00', N'Delta', 150),
           (6, N'hidden', 'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11', '2026-04-01 00:00:00', N'Gamma', 6)`,
          `GRANT SELECT ON SCHEMA::${PROBE_SCHEMA} TO zeteo_ro`,
        ],
      });
      source = await seedQuerySource(
        engine,
        { schemas: [PROBE_SCHEMA] },
        "rrprobe"
      );
      const items = source.tables.items!;
      await grantTo(shown.principal, items, "all", {
        access: "rule",
        rule: { status: { eq: "shown" } },
      });
      await grantTo(stale.principal, items, "all", {
        access: "rule",
        // A rule on code alone: nothing else decides first whether a row's
        // code is converted.
        rule: { code: { lt: 100 } },
      });
      // Changed behind the catalogue's back, which still says integer: a
      // comparison chosen for an integer converts the text per row, and fails
      // on the hidden row's.
      await asProbeAdmin(engine, {
        postgres: [
          `ALTER TABLE ${PROBE_SCHEMA}.items ALTER COLUMN code TYPE text`,
          `UPDATE ${PROBE_SCHEMA}.items SET code = 'A12' WHERE id = ${HIDDEN}`,
          // 150 is not below 100; as text, '0150' is below '100'.
          `UPDATE ${PROBE_SCHEMA}.items SET code = '0150' WHERE id = 3`,
        ],
        mssql: [
          `ALTER TABLE ${PROBE_SCHEMA}.items ALTER COLUMN code nvarchar(20)`,
          `UPDATE ${PROBE_SCHEMA}.items SET code = N'A12' WHERE id = ${HIDDEN}`,
          `UPDATE ${PROBE_SCHEMA}.items SET code = N'0150' WHERE id = 3`,
        ],
      });
    });
    afterAll(async () => {
      await removeRunsOf(users.map((u) => u.id));
      await removeSources([source.id]);
      await closeAllSourcePools();
      await asProbeAdmin(engine, drop);
    });

    /** What a caller sees of one query: its rows' ids, or its error. */
    const outcome = async (token: string, where: Record<string, unknown>) => {
      const res = await postQuery(token, {
        source: source.slug,
        from: "items",
        select: ["id"],
        where,
      });
      return res.status === 200
        ? {
            status: 200,
            ids: (res.body.rows as unknown[][]).map((r) => Number(r[0])),
          }
        : { status: res.status, error: (res.body as { error?: string }).error };
    };

    /** The same probe at each id; the hidden and the missing one must answer alike. */
    const probe = async (
      token: string,
      condition?: Record<string, unknown>
    ) => {
      const at = (id: number) =>
        outcome(token, {
          and: [{ id: { eq: id } }, ...(condition ? [condition] : [])],
        });
      const [hidden, nowhere, visible] = [
        await at(HIDDEN),
        await at(NOWHERE),
        await at(VISIBLE),
      ];
      expect({ condition, hidden }).toEqual({ condition, hidden: nowhere });
      return { hidden, visible };
    };

    it("a rule on a column changed since the catalogue was read tells a hidden row from a missing one by nothing", async () => {
      const { hidden, visible } = await probe(stale.token);
      // A check of the table's metadata (SQL Server's guard, Postgres's live
      // check) refuses before any row is read, whatever the id.
      expect(hidden).toEqual({ status: 409, error: "row_rule_unavailable" });
      expect(visible).toEqual(hidden);
    });

    it("a rule on a column changed since the catalogue was read never keeps a row the rule hides", async () => {
      // As text, '0150' < '100': a comparison chosen by the column's new
      // type would keep row 3, whose code is 150.
      const all = await outcome(stale.token, { id: { gte: 0 } });
      expect(all.status === 200 ? all.ids : []).not.toContain(3);
    });

    it("a timestamp finer than SQL Server reads, beside the rule, tells a hidden row from a missing one by nothing", async () => {
      // datetime2(3) against 9 fractional digits, zeros past the column's 3:
      // applied beside the rule, so an index can serve it (the H1 case).
      for (const stamp of [
        "2026-01-01T00:00:00.000000000Z",
        "2026-01-01T00:00:00.100000000+01:00",
      ]) {
        const { visible } = await probe(shown.token, { stamp: { gte: stamp } });
        expect(visible).toEqual({ status: 200, ids: [VISIBLE] });
      }
    });

    it("a malformed uuid tells a hidden row from a missing one by nothing", async () => {
      // SQL Server converts the text to uniqueidentifier, Postgres to uuid:
      // either fails if it is ever evaluated.
      await probe(shown.token, { ref: { eq: "not-a-guid" } });
      await probe(shown.token, { ref: { ne: "not-a-guid" } });
    });

    it("a match on a column whose collation refuses ILIKE tells a hidden row from a missing one by nothing", async () => {
      // On Postgres label's collation is nondeterministic, where ILIKE raises.
      for (const label of [{ contains: "a" }, { startsWith: "G" }]) {
        await probe(shown.token, { label });
      }
    });

    it("a condition beside a changed rule column tells a hidden row from a missing one by nothing", async () => {
      await probe(stale.token, { code: { eq: 5 } });
      await probe(stale.token, { code: { between: [1, 9] } });
    });
  }
);

// A view's column, or a SQL Server computed column, may be an expression that
// raises per row (`cast(raw as int)`), and a view's persisted column types (on
// SQL Server, a view not bound to its schema) may be stale, which the guard
// reads. No condition of the caller's is applied beside the rule of such an
// object, so the caller cannot pick which hidden row it is evaluated on, and a
// value the rule compares is compared exactly. Each object is the test's own,
// in schema rr_probe_v, dropped before and after.
const VIEW_SCHEMA = "rr_probe_v";

describeEachEngine(
  "row rules, differential probes on views and computed columns",
  (engine) => {
    let source: SeededSource;
    const viewed = newQueryUser();
    const stale = newQueryUser();
    const widened = newQueryUser();
    const computed = newQueryUser();
    const users = [viewed, stale, widened, computed];
    const drop = {
      postgres: [`DROP SCHEMA IF EXISTS ${VIEW_SCHEMA} CASCADE`],
      mssql: [
        `DROP VIEW IF EXISTS ${VIEW_SCHEMA}.v1`,
        `DROP VIEW IF EXISTS ${VIEW_SCHEMA}.v2`,
        `DROP TABLE IF EXISTS ${VIEW_SCHEMA}.t1`,
        `DROP TABLE IF EXISTS ${VIEW_SCHEMA}.t2`,
        `DROP TABLE IF EXISTS ${VIEW_SCHEMA}.t3`,
        `DROP SCHEMA IF EXISTS ${VIEW_SCHEMA}`,
      ],
    };

    beforeAll(async () => {
      await asProbeAdmin(engine, drop);
      await asProbeAdmin(engine, {
        postgres: [
          `CREATE SCHEMA ${VIEW_SCHEMA}`,
          `CREATE TABLE ${VIEW_SCHEMA}.src (id integer PRIMARY KEY, raw text NOT NULL)`,
          `INSERT INTO ${VIEW_SCHEMA}.src VALUES (1, '5'), (2, '7'), (6, 'A12')`,
          `CREATE VIEW ${VIEW_SCHEMA}.v AS SELECT id, cast(raw AS integer) AS code FROM ${VIEW_SCHEMA}.src`,
          `GRANT USAGE ON SCHEMA ${VIEW_SCHEMA} TO zeteo_ro`,
          `GRANT SELECT ON ${VIEW_SCHEMA}.v TO zeteo_ro`,
        ],
        mssql: [
          `CREATE SCHEMA ${VIEW_SCHEMA}`,
          `CREATE TABLE ${VIEW_SCHEMA}.t1 (id int NOT NULL PRIMARY KEY, code int)`,
          `INSERT INTO ${VIEW_SCHEMA}.t1 VALUES (1, 5), (2, 7), (6, 9)`,
          `CREATE VIEW ${VIEW_SCHEMA}.v1 AS SELECT id, code FROM ${VIEW_SCHEMA}.t1`,
          `CREATE TABLE ${VIEW_SCHEMA}.t2 (id int NOT NULL PRIMARY KEY, amount decimal(38,0))`,
          `INSERT INTO ${VIEW_SCHEMA}.t2 VALUES (1, 1), (6, 2)`,
          `CREATE VIEW ${VIEW_SCHEMA}.v2 AS SELECT id, amount FROM ${VIEW_SCHEMA}.t2`,
          `CREATE TABLE ${VIEW_SCHEMA}.t3 (id int NOT NULL PRIMARY KEY, raw nvarchar(20) NOT NULL, calc AS cast(raw AS int))`,
          `INSERT INTO ${VIEW_SCHEMA}.t3 (id, raw) VALUES (1, N'5'), (2, N'7'), (6, N'A12')`,
          `GRANT SELECT ON SCHEMA::${VIEW_SCHEMA} TO zeteo_ro`,
        ],
      });
      source = await seedQuerySource(
        engine,
        { schemas: [VIEW_SCHEMA] },
        "rrview"
      );
      if (engine.type === "azure-sql") {
        await grantTo(stale.principal, source.tables.v1!, "all", {
          access: "rule",
          rule: { code: { ne: 0 } },
        });
        await grantTo(widened.principal, source.tables.v2!, "all", {
          access: "rule",
          rule: { amount: { ne: 1.5 } },
        });
        await grantTo(computed.principal, source.tables.t3!, "all", {
          access: "rule",
          rule: { calc: { lt: 100 } },
        });
        // Changed under the views, whose sys.columns (and the catalogue)
        // still say int and decimal(38,0).
        await asProbeAdmin(engine, {
          postgres: [],
          mssql: [
            `ALTER TABLE ${VIEW_SCHEMA}.t1 ALTER COLUMN code nvarchar(20)`,
            `UPDATE ${VIEW_SCHEMA}.t1 SET code = N'A12' WHERE id = ${HIDDEN}`,
            `ALTER TABLE ${VIEW_SCHEMA}.t2 ALTER COLUMN amount decimal(38,2)`,
            `UPDATE ${VIEW_SCHEMA}.t2 SET amount = 1.50 WHERE id = ${HIDDEN}`,
          ],
        });
      } else {
        await grantTo(viewed.principal, source.tables.v!, "all", {
          access: "rule",
          rule: { code: { lt: 100 } },
        });
      }
    });
    afterAll(async () => {
      await removeRunsOf(users.map((u) => u.id));
      await removeSources([source.id]);
      await closeAllSourcePools();
      await asProbeAdmin(engine, drop);
    });

    const outcome = async (
      token: string,
      from: string,
      where: Record<string, unknown>
    ) => {
      const res = await postQuery(token, {
        source: source.slug,
        from,
        select: ["id"],
        where,
      });
      return res.status === 200
        ? {
            status: 200,
            ids: (res.body.rows as unknown[][]).map((r) => Number(r[0])),
          }
        : { status: res.status, error: (res.body as { error?: string }).error };
    };

    /** `id eq` the hidden and a missing id, seekable beside the rule: they must answer alike. */
    const probe = async (token: string, from: string) => {
      const hidden = await outcome(token, from, { id: { eq: HIDDEN } });
      const nowhere = await outcome(token, from, { id: { eq: NOWHERE } });
      expect({ from, hidden }).toEqual({ from, hidden: nowhere });
    };

    if (engine.type === "azure-sql") {
      it("a view over a column changed under it, which its metadata does not show, tells a hidden row from a missing one by nothing", async () => {
        await probe(stale.token, "v1");
      });

      it("a view's rule keeps no row holding a value its stale type could not hold", async () => {
        const all = await outcome(widened.token, "v2", { id: { gte: 0 } });
        expect(all).toEqual({ status: 200, ids: [VISIBLE] });
      });

      it("a computed column that raises per row tells a hidden row from a missing one by nothing", async () => {
        await probe(computed.token, "t3");
      });
    } else {
      it("a view whose column raises per row tells a hidden row from a missing one by nothing", async () => {
        await probe(viewed.token, "v");
      });
    }
  }
);
