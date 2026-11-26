// @module-tag unit
// @module-tag platform
import { sqlQuerySchema } from "../../../adapters/sql/language.js";
import { RowRuleInputSchema } from "../../../row-rules/schema.js";
import { describe, expect, it } from "vitest";

// A filter's keys are the request's own: a column may be named anything a
// JS object also names (`constructor`), and `__proto__`, the one key parsing
// cannot keep, is refused at its place rather than lost with its condition.

const base = { source: "shop", from: "orders", select: ["id"] };

const issuesOf = (value: unknown) => {
  const result = sqlQuerySchema.safeParse(value);
  return result.success ? [] : result.error.issues;
};

describe("sqlQuerySchema: prototype keys", () => {
  it.each([
    [
      '{"__proto__": {"eq": "x"}, "status": {"eq": "paid"}}',
      ["where", "__proto__"],
    ],
    ['{"and": [{"__proto__": {"eq": "x"}}]}', ["where", "and", 0, "__proto__"]],
    [
      '{"not": {"or": [{"status": {"eq": "a"}}, {"__proto__": {"in": ["x"]}}]}}',
      ["where", "not", "or", 1, "__proto__"],
    ],
  ])(
    "refuses __proto__ as a path, at its place, rather than dropping it: %s",
    (text, path) => {
      // JSON.parse makes "__proto__" an own key, as a request body does.
      const where = JSON.parse(text) as object;
      expect(issuesOf({ ...base, where })).toContainEqual(
        expect.objectContaining({
          path,
          message: '"__proto__" cannot be a path',
        })
      );
    }
  );

  it("refuses __proto__ inside a condition, which takes one operator", () => {
    const where = JSON.parse(
      '{"status": {"__proto__": {"eq": "x"}, "eq": "paid"}}'
    ) as object;
    expect(issuesOf({ ...base, where })).not.toEqual([]);
  });

  it.each(["constructor", "prototype", "toString", "hasOwnProperty"])(
    "keeps %s as a path, as any column name",
    (key) => {
      const where = JSON.parse(
        `{"and": [{"${key}": {"eq": "x"}, "status": {"eq": "paid"}}]}`
      ) as object;
      const parsed = sqlQuerySchema.safeParse({ ...base, where });
      expect(parsed.success).toBe(true);
      expect(
        (parsed.data as { where: { and: object[] } }).where.and[0]
      ).toEqual({ [key]: { eq: "x" }, status: { eq: "paid" } });
      expect(
        Object.hasOwn(
          (parsed.data as { where: { and: object[] } }).where.and[0]!,
          key
        )
      ).toBe(true);
    }
  );

  it("refuses __proto__ in a row rule too, and keeps constructor", () => {
    const rule = JSON.parse(
      '{"__proto__": {"eq": "x"}, "region": {"eq": "west"}}'
    ) as object;
    const parsed = RowRuleInputSchema.safeParse(rule);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["__proto__"]);
    const kept = RowRuleInputSchema.safeParse(
      JSON.parse('{"constructor": {"in": [1, 2]}}')
    );
    expect(kept.success).toBe(true);
    expect(kept.data).toEqual({ constructor: { in: [1, 2] } });
  });
});
