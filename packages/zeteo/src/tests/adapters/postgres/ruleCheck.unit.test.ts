// @module-tag unit
// @module-tag platform
import { describe, expect, it } from "vitest";
import {
  decideRuledReads,
  lockStatements,
  mergeRuledReads,
  tableKey,
  type LiveTable,
  type RuledTableRead,
} from "../../../adapters/postgres/ruleCheck.js";

// Before a rule-limited query runs on Postgres, the tables it reads through
// a rule are locked and their metadata read in the same transaction. The
// decision depends on that metadata only, never on a row: a column the rule
// or a condition beside it compares that has gone or changed type refuses
// the query; a table that is not a plain base table (a view, a materialized
// or foreign table, one with a virtual generated column, a descendant that
// is any of these) is read with its rule alone.

const at = { table: "items", path: ["from"] };

const read = (overrides: Partial<RuledTableRead> = {}): RuledTableRead => ({
  schemaName: "s",
  name: "items",
  columns: [{ name: "code", nativeType: "integer" }],
  at,
  narrowed: true,
  onView: false,
  ...overrides,
});

const live = (overrides: Partial<LiveTable> = {}): LiveTable => ({
  kind: "r",
  plain: true,
  columns: new Map([
    ["id", "integer"],
    ["code", "integer"],
  ]),
  ...overrides,
});

const liveOf = (...tables: [RuledTableRead, LiveTable][]) =>
  new Map(tables.map(([r, l]) => [tableKey(r), l]));

describe("decideRuledReads", () => {
  it("lets a plain base table whose columns match the catalogue keep its conditions beside the rule", () => {
    const r = read();
    expect(decideRuledReads([r], liveOf([r, live()]))).toEqual({
      kind: "run",
      unnarrowed: new Set(),
      recompile: false,
    });
  });

  it("treats a partitioned table whose members are all plain as a base table", () => {
    const r = read();
    expect(
      decideRuledReads([r], liveOf([r, live({ kind: "p" })]))
    ).toMatchObject({ kind: "run", recompile: false });
  });

  it("reads a view, a materialized view or a foreign table with its rule alone", () => {
    for (const kind of ["v", "m", "f"]) {
      const r = read();
      expect(
        decideRuledReads([r], liveOf([r, live({ kind, plain: false })]))
      ).toEqual({
        kind: "run",
        unnarrowed: new Set([tableKey(r)]),
        recompile: true,
      });
    }
  });

  it("reads a table with a virtual generated column, named or not, or a member that is not plain, with its rule alone", () => {
    const r = read();
    expect(
      decideRuledReads([r], liveOf([r, live({ kind: "r", plain: false })]))
    ).toEqual({
      kind: "run",
      unnarrowed: new Set([tableKey(r)]),
      recompile: true,
    });
  });

  it("compiles again only when a table read with its rule alone had conditions beside it", () => {
    const r = read({ narrowed: false });
    expect(
      decideRuledReads([r], liveOf([r, live({ kind: "v", plain: false })]))
    ).toEqual({
      kind: "run",
      unnarrowed: new Set([tableKey(r)]),
      recompile: false,
    });
  });

  it("refuses a table that has gone, naming where it is read", () => {
    const r = read();
    expect(decideRuledReads([r], new Map())).toEqual({ kind: "refuse", at });
  });

  it("refuses a column that has gone or whose type differs from the catalogue's", () => {
    const r = read();
    for (const columns of [
      new Map([["id", "integer"]]),
      new Map([["code", "text"]]),
      new Map([["code", "bigint"]]),
    ]) {
      expect(decideRuledReads([r], liveOf([r, live({ columns })]))).toEqual({
        kind: "refuse",
        at,
      });
    }
  });

  it("compares types as the catalogue refresh writes them, domains, citext, money and typmods included", () => {
    for (const nativeType of [
      "s.code_d (domain over integer)",
      "citext",
      "money",
      "character varying(20)",
      "numeric(12,2)",
      "timestamp with time zone",
      "integer[]",
    ]) {
      const r = read({ columns: [{ name: "code", nativeType }] });
      expect(
        decideRuledReads(
          [r],
          liveOf([r, live({ columns: new Map([["code", nativeType]]) })])
        ).kind
      ).toBe("run");
      expect(
        decideRuledReads(
          [r],
          liveOf([r, live({ columns: new Map([["code", "text"]]) })])
        ).kind
      ).toBe("refuse");
    }
  });

  it("refuses on a changed column even where the table would be read with its rule alone", () => {
    const r = read();
    expect(
      decideRuledReads(
        [r],
        liveOf([
          r,
          live({
            kind: "v",
            plain: false,
            columns: new Map([["code", "text"]]),
          }),
        ])
      )
    ).toEqual({ kind: "refuse", at });
  });

  it("decides each table apart", () => {
    const a = read();
    const b = read({
      name: "other",
      at: { table: "other", path: ["joins", 0] },
    });
    expect(
      decideRuledReads(
        [a, b],
        liveOf([a, live()], [b, live({ kind: "v", plain: false })])
      )
    ).toEqual({
      kind: "run",
      unnarrowed: new Set([tableKey(b)]),
      recompile: true,
    });
    expect(
      decideRuledReads(
        [a, b],
        liveOf([a, live()], [b, live({ columns: new Map() })])
      )
    ).toEqual({ kind: "refuse", at: b.at });
  });
});

describe("mergeRuledReads", () => {
  it("merges the reads of one table: every column once, narrowed if any was", () => {
    const merged = mergeRuledReads([
      read({ narrowed: false }),
      read({
        columns: [
          { name: "id", nativeType: "integer" },
          { name: "code", nativeType: "integer" },
        ],
        at: { table: "items", path: ["joins", 0] },
      }),
    ]);
    expect(merged).toEqual([
      read({
        columns: [
          { name: "code", nativeType: "integer" },
          { name: "id", nativeType: "integer" },
        ],
      }),
    ]);
  });
});

describe("lockStatements", () => {
  it("locks a catalogued table, its descendants and a view's tables in ACCESS SHARE mode; a catalogued view by a read of no row", () => {
    expect(
      lockStatements([
        read({ schemaName: 'we"ird', name: "items" }),
        read({ name: "v", onView: true }),
      ])
    ).toEqual([
      'lock table "we""ird"."items" in access share mode',
      'select from "s"."v" where false',
    ]);
  });
});
