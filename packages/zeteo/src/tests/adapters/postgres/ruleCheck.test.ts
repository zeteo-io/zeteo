// @module-tag int
// @module-tag platform
import { ENGINES, type EngineFixture } from "../../support/engines.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixtureAdminSettings } from "../../support/fixtureDb.js";
import { closeAllSourcePools } from "../../../sources/pools.js";
import type { RuleFilter } from "../../../row-rules/types.js";
import { removeSources } from "../../support/sources.js";
import { Client } from "pg";
import {
  grantTo,
  newQueryUser,
  postQuery,
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../../support/queries.js";

// Postgres reads a table's metadata before a rule-limited query, locked, in
// the query's own transaction: what the catalogue says may be stale. A table
// that is not a plain base table now (a view put in its place, a virtual
// generated column, computed when read) is read with its rule alone, so no
// condition of the caller's picks the hidden rows its expressions run on; a
// column the rule compares whose type has changed refuses the query, the
// same whatever the row. Differential probes: one query asked of a hidden
// row's id and of an id no row has must get the same answer. Every object is
// the test's own, in schema rr_probe_live, dropped before and after.

const SCHEMA = "rr_probe_live";
const HIDDEN = 6;
const NOWHERE = 99;

const postgres = ENGINES.find((e) => e.type === "postgres") as EngineFixture;

const asAdmin = async (statements: string[]): Promise<void> => {
  const admin = new Client({ ...fixtureAdminSettings(), ssl: false });
  await admin.connect();
  try {
    for (const statement of statements) await admin.query(statement);
  } finally {
    await admin.end();
  }
};

const DROP = [`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`];

describe("row rules, Postgres live metadata check", () => {
  let source: SeededSource;
  const caller = newQueryUser();

  beforeAll(async () => {
    await asAdmin(DROP);
    await asAdmin([
      `CREATE SCHEMA ${SCHEMA}`,
      `CREATE DOMAIN ${SCHEMA}.code_d AS integer`,
      // A virtual generated column the rule compares, which raises on the
      // hidden row's raw text.
      `CREATE TABLE ${SCHEMA}.gen (id integer PRIMARY KEY, raw text NOT NULL, code integer GENERATED ALWAYS AS (cast(raw AS integer)) VIRTUAL)`,
      `INSERT INTO ${SCHEMA}.gen (id, raw) VALUES (1, '5'), (2, '7'), (${HIDDEN}, 'abc')`,
      // One the rule does not name.
      `CREATE TABLE ${SCHEMA}.gen2 (id integer PRIMARY KEY, status text NOT NULL, raw text NOT NULL, code integer GENERATED ALWAYS AS (cast(raw AS integer)) VIRTUAL)`,
      `INSERT INTO ${SCHEMA}.gen2 (id, status, raw) VALUES (1, 'shown', '5'), (2, 'shown', '7'), (${HIDDEN}, 'hidden', 'abc')`,
      // A table now, a view over text by the time the query runs.
      `CREATE TABLE ${SCHEMA}.swap (id integer PRIMARY KEY, code integer)`,
      `INSERT INTO ${SCHEMA}.swap VALUES (1, 5), (2, 7), (${HIDDEN}, 9)`,
      `CREATE TABLE ${SCHEMA}.cash (id integer PRIMARY KEY, price money)`,
      `INSERT INTO ${SCHEMA}.cash VALUES (1, 5), (2, 7), (${HIDDEN}, 9)`,
      `CREATE TABLE ${SCHEMA}.dom (id integer PRIMARY KEY, code ${SCHEMA}.code_d)`,
      `INSERT INTO ${SCHEMA}.dom VALUES (1, 1), (2, 2), (3, 150), (${HIDDEN}, 6)`,
      `CREATE TABLE ${SCHEMA}.domok (id integer PRIMARY KEY, code ${SCHEMA}.code_d)`,
      `INSERT INTO ${SCHEMA}.domok VALUES (1, 1), (3, 150)`,
      `CREATE TABLE ${SCHEMA}.ci (id integer PRIMARY KEY, tag public.citext)`,
      `INSERT INTO ${SCHEMA}.ci VALUES (1, '10'), (2, '7'), (${HIDDEN}, '60')`,
      `CREATE TABLE ${SCHEMA}.ciok (id integer PRIMARY KEY, tag public.citext)`,
      `INSERT INTO ${SCHEMA}.ciok VALUES (1, 'Alpha'), (2, 'beta')`,
      `GRANT USAGE ON SCHEMA ${SCHEMA} TO zeteo_ro`,
      `GRANT SELECT ON ALL TABLES IN SCHEMA ${SCHEMA} TO zeteo_ro`,
    ]);
    source = await seedQuerySource(postgres, { schemas: [SCHEMA] }, "rrlive");
    const rule = async (table: string, filter: RuleFilter) =>
      grantTo(caller.principal, source.tables[table]!, "all", {
        access: "rule",
        rule: filter,
      });
    await rule("gen", { code: { lt: 100 } });
    await rule("gen2", { status: { eq: "shown" } });
    await rule("swap", { code: { lt: 100 } });
    await rule("cash", { price: { lt: 100 } });
    await rule("dom", { code: { lt: 100 } });
    await rule("domok", { code: { lt: 100 } });
    // As text, '10' < '5'; as an integer, 10 is not below 5.
    await rule("ci", { tag: { lt: "5" } });
    await rule("ciok", { tag: { eq: "ALPHA" } });
    // Changed behind the catalogue's back.
    await asAdmin([
      `DROP TABLE ${SCHEMA}.swap`,
      `CREATE TABLE ${SCHEMA}.swap_src (id integer PRIMARY KEY, raw text NOT NULL)`,
      `INSERT INTO ${SCHEMA}.swap_src VALUES (1, '5'), (2, '7'), (${HIDDEN}, 'A12')`,
      `CREATE VIEW ${SCHEMA}.swap AS SELECT id, cast(raw AS integer) AS code FROM ${SCHEMA}.swap_src`,
      `GRANT SELECT ON ${SCHEMA}.swap TO zeteo_ro`,
      `ALTER TABLE ${SCHEMA}.cash ALTER COLUMN price TYPE text`,
      `UPDATE ${SCHEMA}.cash SET price = 'n/a' WHERE id = ${HIDDEN}`,
      `ALTER TABLE ${SCHEMA}.dom ALTER COLUMN code TYPE text`,
      // 150 is not below 100; as text, '0150' is below '100'.
      `UPDATE ${SCHEMA}.dom SET code = '0150' WHERE id = 3`,
      `ALTER TABLE ${SCHEMA}.ci ALTER COLUMN tag TYPE integer USING cast(tag AS integer)`,
    ]);
  });
  afterAll(async () => {
    await removeRunsOf([caller.id]);
    await removeSources([source.id]);
    await closeAllSourcePools();
    await asAdmin(DROP);
  });

  /** What the caller sees of one query: its rows' ids, or its error. */
  const outcome = async (from: string, where: Record<string, unknown>) => {
    const res = await postQuery(caller.token, {
      source: source.slug,
      from,
      select: ["id"],
      where,
      orderBy: [{ id: "asc" }],
    });
    return res.status === 200
      ? {
          status: 200,
          ids: (res.body.rows as unknown[][]).map((r) => Number(r[0])),
        }
      : {
          status: res.status,
          error: (res.body as { error?: string }).error,
          message: (res.body as { error_description?: string })
            .error_description,
        };
  };

  /** `id eq` the hidden and a missing id, seekable beside the rule: they must answer alike. */
  const probe = async (from: string, condition?: Record<string, unknown>) => {
    const at = (id: number) =>
      outcome(from, {
        and: [{ id: { eq: id } }, ...(condition ? [condition] : [])],
      });
    const hidden = await at(HIDDEN);
    const nowhere = await at(NOWHERE);
    expect({ from, hidden }).toEqual({ from, hidden: nowhere });
    return hidden;
  };

  it("a virtual generated column the rule compares tells a hidden row from a missing one by nothing", async () => {
    await probe("gen");
  });

  it("a virtual generated column the rule does not name tells a hidden row from a missing one by nothing, and the rule keeps its rows", async () => {
    await probe("gen2", { code: { eq: 5 } });
    expect(await outcome("gen2", { id: { gte: 0 } })).toEqual({
      status: 200,
      ids: [1, 2],
    });
  });

  it("a view put in a table's place tells a hidden row from a missing one by nothing", async () => {
    await probe("swap");
  });

  it("a money rule column changed to text is refused, whatever the row", async () => {
    const hidden = await probe("cash");
    expect(hidden).toEqual({
      status: 409,
      error: "row_rule_unavailable",
      message: expect.stringContaining("cash"),
    });
  });

  it("a domain rule column changed to text is refused, never comparing as text", async () => {
    expect(await outcome("dom", { id: { gte: 0 } })).toMatchObject({
      status: 409,
      error: "row_rule_unavailable",
    });
  });

  it("a citext rule column changed to integer is refused, never comparing as numbers", async () => {
    expect(await outcome("ci", { id: { gte: 0 } })).toMatchObject({
      status: 409,
      error: "row_rule_unavailable",
    });
  });

  it("unchanged domain and citext rule columns keep the rows their rules say", async () => {
    expect(await outcome("domok", { id: { gte: 0 } })).toEqual({
      status: 200,
      ids: [1],
    });
    expect(await outcome("ciok", { id: { gte: 0 } })).toEqual({
      status: 200,
      ids: [1],
    });
  });
});
