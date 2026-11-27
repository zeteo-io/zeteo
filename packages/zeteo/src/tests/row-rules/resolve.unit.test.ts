// @module-tag unit
// @module-tag platform
import type { RowAccess, RuleFilter } from "../../row-rules/types.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  combineRowAccess,
  resolveGrantRule,
  resolveRowRules,
  type GrantRow,
  type RuleColumn,
} from "../../row-rules/resolve.js";
import {
  HierarchyTooLargeError,
  HierarchyUnavailableError,
} from "../../grants/hierarchy.js";

const mocked = vi.hoisted(() => ({
  findMany: vi.fn(),
  valuesOfUser: vi.fn(),
  valuesOfUsers: vi.fn(),
  usersBelow: vi.fn(),
}));
vi.mock("../../utils/db/prisma.js", () => ({
  prisma: { sourceColumn: { findMany: mocked.findMany } },
}));
vi.mock("../../identity/service.js", () => ({
  valuesOfUser: mocked.valuesOfUser,
  valuesOfUsers: mocked.valuesOfUsers,
}));
vi.mock(import("../../grants/hierarchy.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  usersBelow: mocked.usersBelow,
}));

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

describe("resolveGrantRule with an operator that cannot take an identity", () => {
  it("throws rather than key a list by undefined", () => {
    const columns = new Map<string, RuleColumn>([
      ["c_rep", { id: "c_rep", name: "rep", type: "text", nativeType: "text" }],
    ]);
    const rule = { c_rep: { gt: { identity: "k1" } } } as unknown as RuleFilter;
    expect(() =>
      resolveGrantRule(rule, new Map([["k1", ["a"]]]), columns)
    ).toThrow(/cannot take an identity/);
  });
});

describe("resolveRowRules with below", () => {
  const column = {
    id: "c_rep",
    tableId: "t1",
    name: "rep",
    type: "text",
    nativeType: "text",
    missingSince: null,
  };
  const ruleGrant = (rule: RuleFilter, id = "g1"): GrantRow => ({
    id,
    rowAccess: "rule",
    rowRule: rule,
    rowRuleDescription: null,
  });
  const below = (identity = "k1"): RuleFilter => ({
    c_rep: { in: { identity, below: true } },
  });
  const resolve = (...grants: GrantRow[]) =>
    resolveRowRules("caller", new Map([["t1", grants]]));
  const valuesOf = (entries: Array<[string, string[]]>) =>
    new Map<string, string[]>(entries);

  beforeEach(() => {
    vi.resetAllMocks();
    mocked.findMany.mockResolvedValue([column]);
    mocked.valuesOfUser.mockResolvedValue(new Map());
    mocked.valuesOfUsers.mockResolvedValue(new Map());
  });

  it("puts in the values of the caller and of everyone below them", async () => {
    mocked.usersBelow.mockResolvedValue(["r1", "r2"]);
    mocked.valuesOfUsers.mockResolvedValue(valuesOf([["k1", ["1", "2", "3"]]]));
    const rules = await resolve(ruleGrant(below()));
    expect(mocked.usersBelow).toHaveBeenCalledTimes(1);
    expect(mocked.usersBelow).toHaveBeenCalledWith("caller");
    expect(mocked.valuesOfUsers).toHaveBeenCalledWith(
      ["caller", "r1", "r2"],
      ["k1"]
    );
    expect(rules.get("t1")).toMatchObject({
      kind: "filter",
      filter: { c_rep: { in: ["1", "2", "3"] } },
    });
  });

  it("gives a caller with no value of their own the values of those below", async () => {
    mocked.usersBelow.mockResolvedValue(["r1"]);
    mocked.valuesOfUsers.mockResolvedValue(valuesOf([["k1", ["2"]]]));
    expect((await resolve(ruleGrant(below()))).get("t1")).toMatchObject({
      kind: "filter",
      filter: { c_rep: { in: ["2"] } },
    });
  });

  it("gives a caller with no reports exactly their own values", async () => {
    mocked.usersBelow.mockResolvedValue([]);
    mocked.valuesOfUsers.mockResolvedValue(valuesOf([["k1", ["1"]]]));
    expect((await resolve(ruleGrant(below()))).get("t1")).toMatchObject({
      kind: "filter",
      filter: { c_rep: { in: ["1"] } },
    });
    expect(mocked.valuesOfUsers).toHaveBeenCalledWith(["caller"], ["k1"]);
  });

  it("is never when neither the caller nor anyone below holds a value", async () => {
    mocked.usersBelow.mockResolvedValue(["r1"]);
    expect((await resolve(ruleGrant(below()))).get("t1")).toEqual({
      kind: "never",
    });
  });

  it("keeps a plain identity to the caller's own values beside a below one", async () => {
    mocked.usersBelow.mockResolvedValue(["r1"]);
    mocked.valuesOfUser.mockResolvedValue(valuesOf([["k1", ["1"]]]));
    mocked.valuesOfUsers.mockResolvedValue(valuesOf([["k1", ["1", "2"]]]));
    const rules = await resolve(
      ruleGrant(below(), "g1"),
      ruleGrant({ c_rep: { eq: { identity: "k1" } } }, "g2")
    );
    expect(rules.get("t1")).toMatchObject({
      kind: "filter",
      filter: {
        or: [{ c_rep: { in: ["1", "2"] } }, { c_rep: { in: ["1"] } }],
      },
    });
  });

  it("is unavailable, never the caller's own rows, when the hierarchy cannot be read", async () => {
    mocked.usersBelow.mockRejectedValue(new HierarchyUnavailableError());
    mocked.valuesOfUser.mockResolvedValue(valuesOf([["k1", ["1"]]]));
    const rules = await resolve(
      ruleGrant(below(), "g1"),
      ruleGrant({ c_rep: { eq: { identity: "k1" } } }, "g2")
    );
    expect(rules.get("t1")).toEqual({
      kind: "unavailable",
      reason: "hierarchy_unavailable",
    });
  });

  it("leaves a table without below alone when the hierarchy cannot be read", async () => {
    mocked.usersBelow.mockRejectedValue(new HierarchyUnavailableError());
    mocked.findMany.mockResolvedValue([
      column,
      { ...column, id: "c_other", tableId: "t2" },
    ]);
    const rules = await resolveRowRules(
      "caller",
      new Map([
        ["t1", [ruleGrant(below())]],
        ["t2", [ruleGrant({ c_other: { eq: "x" } }, "g2")]],
      ])
    );
    expect(rules.get("t1")).toEqual({
      kind: "unavailable",
      reason: "hierarchy_unavailable",
    });
    expect(rules.get("t2")).toMatchObject({ kind: "filter" });
  });

  it("is too many values when tereo refuses the hierarchy as too large", async () => {
    mocked.usersBelow.mockRejectedValue(new HierarchyTooLargeError());
    expect((await resolve(ruleGrant(below()))).get("t1")).toEqual({
      kind: "unavailable",
      reason: "too_many_values",
    });
  });

  it("counts the values of everyone below against the cap", async () => {
    mocked.usersBelow.mockResolvedValue(["r1"]);
    mocked.valuesOfUsers.mockResolvedValue(
      valuesOf([["k1", Array.from({ length: 50_001 }, (_, i) => `${i}`)]])
    );
    expect((await resolve(ruleGrant(below()))).get("t1")).toEqual({
      kind: "unavailable",
      reason: "too_many_values",
    });
  });

  it("gives a service account only its own values, without asking tereo", async () => {
    mocked.valuesOfUsers.mockResolvedValue(valuesOf([["k1", ["7"]]]));
    const rules = await resolveRowRules(
      "svc",
      new Map([["t1", [ruleGrant(below())]]]),
      { isServiceAccount: true }
    );
    expect(mocked.usersBelow).not.toHaveBeenCalled();
    expect(mocked.valuesOfUsers).toHaveBeenCalledWith(["svc"], ["k1"]);
    expect(rules.get("t1")).toMatchObject({
      kind: "filter",
      filter: { c_rep: { in: ["7"] } },
    });
  });

  it("still refuses a user whose reporting lines tereo cannot read", async () => {
    mocked.usersBelow.mockRejectedValue(new HierarchyUnavailableError());
    const rules = await resolveRowRules(
      "caller",
      new Map([["t1", [ruleGrant(below())]]]),
      { isServiceAccount: false }
    );
    expect(rules.get("t1")).toEqual({
      kind: "unavailable",
      reason: "hierarchy_unavailable",
    });
  });

  it("never reads the hierarchy for rules without below", async () => {
    mocked.valuesOfUser.mockResolvedValue(valuesOf([["k1", ["1"]]]));
    await resolve(ruleGrant({ c_rep: { in: { identity: "k1" } } }));
    expect(mocked.usersBelow).not.toHaveBeenCalled();
    expect(mocked.valuesOfUsers).not.toHaveBeenCalled();
  });
});
