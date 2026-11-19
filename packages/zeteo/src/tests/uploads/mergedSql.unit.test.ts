// @module-tag unit
// @module-tag platform
import { describe, expect, it } from "vitest";
import {
  mergedViewSql,
  sqlLiteral,
  type ResolvedMerged,
} from "../../uploads/mergedSql.js";

const def = (over: Partial<ResolvedMerged> = {}): ResolvedMerged => ({
  labelColumn: "store",
  columns: [
    { name: "sku", type: "text" },
    { name: "qty", type: "number" },
  ],
  members: [
    { physicalTable: "t1", label: "A", columnNames: ["sku", "qty"] },
    { physicalTable: "t2", label: "B", columnNames: ["sku", null] },
  ],
  ...over,
});

describe("sqlLiteral", () => {
  it("sqlLiteral doubles quotes", () => {
    expect(sqlLiteral("it's")).toBe("E'it''s'");
  });
  it("sqlLiteral refuses NUL", () => {
    expect(() => sqlLiteral("a\0b")).toThrow();
  });
  it("sqlLiteral refuses a label over 100 characters", () => {
    expect(() => sqlLiteral("a".repeat(101))).toThrow(/100/);
    expect(sqlLiteral("a".repeat(100))).toHaveLength(103);
  });
});

describe("sqlLiteral backslashes", () => {
  it("a backslash-quote label stays one literal", () => {
    expect(sqlLiteral("\\'; drop table t; --")).toBe(
      "E'\\\\''; drop table t; --'"
    );
  });
});

describe("mergedViewSql", () => {
  it("mergedViewSql emits UNION ALL with NULL for a member lacking a column", () => {
    expect(mergedViewSql("zu_x", "v", def())).toBe(
      `CREATE VIEW "zu_x"."v" AS ` +
        `SELECT E'A'::text AS "store", "sku"::text AS "sku", "qty"::numeric AS "qty" FROM "zu_x"."t1" ` +
        `UNION ALL ` +
        `SELECT E'B'::text AS "store", "sku"::text AS "sku", NULL::numeric AS "qty" FROM "zu_x"."t2"`
    );
  });
  it(`labels with "x'); drop table t; --" stay a literal`, () => {
    const sql = mergedViewSql(
      "zu_x",
      "v",
      def({
        members: [
          {
            physicalTable: "t1",
            label: "x'); drop table t; --",
            columnNames: ["sku", "qty"],
          },
        ],
      })
    );
    expect(sql).toContain("E'x''); drop table t; --'");
  });
  it("identifiers with a double quote are quoted safely", () => {
    const sql = mergedViewSql(
      "zu_x",
      "v",
      def({
        columns: [{ name: 'a"b', type: "text" }],
        members: [{ physicalTable: "t1", label: "A", columnNames: ['a"b'] }],
      })
    );
    expect(sql).toContain(`"a""b"::text AS "a""b"`);
  });
  it("refuses a table with no members", () => {
    expect(() => mergedViewSql("zu_x", "v", def({ members: [] }))).toThrow();
  });
});
