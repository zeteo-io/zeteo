// @module-tag unit
// @module-tag platform
import { describe, expect, it } from "vitest";
import {
  parseRuleBody,
  RoundedNumber,
  writtenExactly,
} from "../../row-rules/numbers.js";

// A JSON number in a row rule must be the number its text says: one a double
// rounded (more digits than it keeps, or an integer past 2^53) would match
// other rows than the one written.

describe("writtenExactly", () => {
  it.each([
    ["1.50", 1.5],
    ["-0", -0],
    ["0.30000000000000004", 0.30000000000000004],
    ["1e21", 1e21],
    ["1E-7", 1e-7],
    ["12.5e1", 125],
    ["9007199254740992", 2 ** 53],
    ["1.2345678901234567", 1.2345678901234567],
  ])("holds for %s", (source, n) => {
    expect(writtenExactly(source, n)).toBe(true);
  });

  it.each([
    ["0.10000000000000001", 0.1],
    ["1.0000000000000001", 1],
    ["9007199254740993", 2 ** 53],
    ["123456789012345678901", Number("123456789012345678901")],
    ["1e400", Infinity],
  ])("fails for %s, which parses to another number", (source, n) => {
    expect(writtenExactly(source, n)).toBe(false);
  });
});

describe("parseRuleBody", () => {
  it("marks each number a double rounded, with the text written, and keeps the others", () => {
    const body = parseRuleBody(
      '{"row_rule": {"and": [{"total": {"in": [1.5, 0.10000000000000001]}}]}, "n": 2}'
    ) as {
      row_rule: { and: [{ total: { in: unknown[] } }] };
      n: number;
    };
    const [exact, rounded] = body.row_rule.and[0].total.in;
    expect(exact).toBe(1.5);
    expect(rounded).toBeInstanceOf(RoundedNumber);
    expect((rounded as RoundedNumber).source).toBe("0.10000000000000001");
    expect(body.n).toBe(2);
  });
});
