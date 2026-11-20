// @module-tag unit
// @module-tag platform
import type { RowAccess, RuleFilter } from "../../row-rules/types.js";
import { describe, expect, it } from "vitest";
import {
  combineRowAccess,
  resolveGrantRule,
  type RuleColumn,
} from "../../row-rules/resolve.js";

const grant = (
  id: string,
  rowAccess: RowAccess,
  rowRule: RuleFilter | null = null
) => ({ id, rowAccess, rowRule });

const statusRule: RuleFilter = { c_status: { eq: "paid" } };
const repRule: RuleFilter = { c_rep: { in: { identity: "k1" } } };

describe("combineRowAccess", () => {
  it("is all rows when every grant leaves rows unlimited", () => {
    expect(
      combineRowAccess([
        grant("g1", "unlimited_default"),
        grant("g2", "unlimited_default"),
      ])
    ).toEqual({ kind: "all" });
  });

  it("is all rows when one grant is all among rules", () => {
    expect(
      combineRowAccess([
        grant("g1", "rule", statusRule),
        grant("g2", "all"),
        grant("g3", "rule", repRule),
      ])
    ).toEqual({ kind: "all" });
  });

  it("keeps every rule when several grants have one", () => {
    expect(
      combineRowAccess([
        grant("g1", "rule", statusRule),
        grant("g2", "rule", repRule),
      ])
    ).toEqual({
      kind: "rules",
      grants: [
        { id: "g1", rule: statusRule },
        { id: "g2", rule: repRule },
      ],
    });
  });

  it("lets a rule limit rows a default grant leaves unlimited", () => {
    expect(
      combineRowAccess([
        grant("g1", "unlimited_default"),
        grant("g2", "rule", repRule),
      ])
    ).toEqual({ kind: "rules", grants: [{ id: "g2", rule: repRule }] });
  });

  it("is the same whatever the order of the grants", () => {
    const a = [grant("g1", "rule", statusRule), grant("g2", "all")];
    expect(combineRowAccess(a)).toEqual(combineRowAccess([...a].reverse()));
  });
});

describe("resolveGrantRule", () => {
  const columns = new Map<string, RuleColumn>([
    ["c_rep", { id: "c_rep", name: "rep", type: "text", nativeType: "text" }],
    [
      "c_num",
      { id: "c_num", name: "num", type: "number", nativeType: "integer" },
    ],
    ["c_day", { id: "c_day", name: "day", type: "date", nativeType: "date" }],
    [
      "c_status",
      { id: "c_status", name: "status", type: "text", nativeType: "text" },
    ],
  ]);
  const values = new Map([
    ["k1", ["Jane", "Joe"]],
    ["k2", ["1042", "Jane"]],
    ["k3", ["not a date", "Jane"]],
  ]);
  const id = (identity: string) => ({ identity });

  it("puts the caller's values in place of an identity under in", () => {
    expect(
      resolveGrantRule({ c_rep: { in: id("k1") } }, values, columns)
    ).toEqual({ c_rep: { in: ["Jane", "Joe"] } });
  });

  it("reads eq as one of the values and ne as none of them", () => {
    expect(
      resolveGrantRule(
        { and: [{ c_rep: { eq: id("k1") } }, { c_status: { ne: id("k1") } }] },
        values,
        columns
      )
    ).toEqual({
      and: [
        { c_rep: { in: ["Jane", "Joe"] } },
        { c_status: { notIn: ["Jane", "Joe"] } },
      ],
    });
  });

  it("keeps literals, relative dates and isBusinessDay as written", () => {
    const rule: RuleFilter = {
      and: [
        { c_status: { in: ["paid", "open"] } },
        { c_day: { gte: { relative: { unit: "day", offset: -90 } } } },
        { not: { c_day: { isBusinessDay: true } } },
      ],
    };
    expect(resolveGrantRule(rule, values, columns)).toEqual(rule);
  });

  it.each<[string, RuleFilter]>([
    ["in", { c_rep: { in: id("empty") } }],
    ["eq", { c_rep: { eq: id("empty") } }],
    ["notIn", { c_rep: { notIn: id("empty") } }],
    ["ne", { c_rep: { ne: id("empty") } }],
    ["not around in", { not: { c_rep: { in: id("empty") } } }],
    [
      "or with a literal",
      { or: [{ c_status: { eq: "paid" } }, { c_rep: { notIn: id("empty") } }] },
    ],
  ])("is never for an identity with no values (%s)", (_, rule) => {
    expect(resolveGrantRule(rule, values, columns)).toBe("never");
  });

  it("drops the values that are not of the column's type", () => {
    expect(
      resolveGrantRule({ c_num: { in: id("k2") } }, values, columns)
    ).toEqual({ c_num: { in: ["1042"] } });
  });

  it("is never when none of the values is of the column's type", () => {
    expect(
      resolveGrantRule({ c_day: { notIn: id("k3") } }, values, columns)
    ).toBe("never");
  });
});
