// @module-tag unit
// @module-tag platform
import type { RuleFilter } from "../../row-rules/types.js";
import { describe, expect, it } from "vitest";
import {
  describeRowRule,
  rowsLimitedReason,
} from "../../row-rules/describe.js";
import type {
  RowRule,
  RuleColumn,
  RuleDescriptionPart,
} from "../../row-rules/resolve.js";

const column = (
  id: string,
  name: string,
  type: RuleColumn["type"] = "text"
): [string, RuleColumn] => [id, { id, name, type, nativeType: type }];

const columns = new Map<string, RuleColumn>([
  column("c_channel", "channel"),
  column("c_rep", "sales_rep"),
  column("c_date", "sale_date", "date"),
  column("c_amount", "amount", "number"),
  column("c_secret", "margin_band"),
]);
const granted: ReadonlySet<string> = new Set([
  "c_channel",
  "c_rep",
  "c_date",
  "c_amount",
]);
const keyLabels = new Map([["k_emp", "NetSuite employee ID"]]);

const part = (
  stored: RuleFilter,
  custom: string | null = null,
  grantId = "g1"
): RuleDescriptionPart => ({ grantId, custom, stored });

const say = (...parts: RuleDescriptionPart[]) =>
  describeRowRule(parts, granted, columns, keyLabels);

describe("describeRowRule", () => {
  it("describes a list of values", () => {
    expect(say(part({ c_channel: { in: ["Retail", "Wholesale"] } }))).toBe(
      "channel is one of Retail, Wholesale"
    );
  });

  it("describes an excluded list of values", () => {
    expect(say(part({ c_channel: { notIn: ["Retail"] } }))).toBe(
      "channel is none of Retail"
    );
  });

  it("names an identity key by its label, never its id", () => {
    const text = say(part({ c_rep: { in: { identity: "k_emp" } } }));
    expect(text).toBe("sales_rep is your NetSuite employee ID");
    expect(text).not.toContain("k_emp");
    expect(say(part({ c_rep: { eq: { identity: "k_emp" } } }))).toBe(
      "sales_rep is your NetSuite employee ID"
    );
  });

  it("describes an excluded identity", () => {
    expect(say(part({ c_rep: { notIn: { identity: "k_emp" } } }))).toBe(
      "sales_rep is none of your NetSuite employee ID"
    );
    expect(say(part({ c_rep: { ne: { identity: "k_emp" } } }))).toBe(
      "sales_rep is none of your NetSuite employee ID"
    );
  });

  it("describes a relative date window", () => {
    expect(
      say(part({ c_date: { gte: { relative: { unit: "day", offset: -90 } } } }))
    ).toBe("sale_date from the last 90 days");
  });

  it("renders and, or and not in words", () => {
    expect(
      say(
        part({
          and: [
            { c_rep: { in: { identity: "k_emp" } } },
            {
              or: [
                { c_channel: { eq: "Retail" } },
                { not: { c_amount: { gt: 100 } } },
              ],
            },
          ],
        })
      )
    ).toBe(
      "sales_rep is your NetSuite employee ID and (channel is Retail or not (amount is more than 100))"
    );
  });

  it("describes a condition on an ungranted column without the column", () => {
    const text = say(part({ c_secret: { in: ["A", "B"] } }));
    expect(text).toBe("some rows only");
    expect(text).not.toContain("margin_band");
    const mixed = say(
      part({
        and: [{ c_secret: { eq: "A" } }, { c_channel: { eq: "Retail" } }],
      })
    );
    expect(mixed).toBe("some rows only and channel is Retail");
    expect(mixed).not.toContain("margin_band");
  });

  it("describes an identity condition on an ungranted column without the column", () => {
    const text = say(part({ c_secret: { in: { identity: "k_emp" } } }));
    expect(text).not.toContain("margin_band");
    expect(text).toBe("some rows only");
  });

  it("uses a grant's own description over the generated sentence", () => {
    expect(say(part({ c_secret: { eq: "A" } }, "Your region's orders"))).toBe(
      "Your region's orders"
    );
  });

  it("joins the grants' descriptions with '; or '", () => {
    expect(
      say(
        part({ c_channel: { eq: "Retail" } }, null, "g1"),
        part({ c_rep: { in: { identity: "k_emp" } } }, "Your own sales", "g2")
      )
    ).toBe("channel is Retail; or Your own sales");
  });

  it("never shows an identity value", () => {
    // Stored rules carry key ids only; the caller's values are not an input.
    const text = say(
      part({ c_rep: { in: { identity: "k_emp" } } }),
      part({ c_rep: { notIn: { identity: "k_emp" } } }, null, "g2")
    );
    expect(text).not.toMatch(/k_emp|identity/);
  });

  it("describes the other operators", () => {
    expect(say(part({ c_amount: { between: [1, 5] } }))).toBe(
      "amount is between 1 and 5"
    );
    expect(say(part({ c_channel: { contains: "tail" } }))).toBe(
      'channel contains "tail"'
    );
    expect(say(part({ c_channel: { startsWith: "Re" } }))).toBe(
      'channel starts with "Re"'
    );
    expect(say(part({ c_channel: { isNull: true } }))).toBe("channel is empty");
    expect(say(part({ c_channel: { isNull: false } }))).toBe(
      "channel is not empty"
    );
    expect(say(part({ c_channel: { ne: "Retail" } }))).toBe(
      "channel is not Retail"
    );
    expect(say(part({ c_amount: { lte: 10 } }))).toBe("amount is at most 10");
    expect(say(part({ c_date: { lt: "2026-01-01" } }))).toBe(
      "sale_date is before 2026-01-01"
    );
    expect(say(part({ c_date: { isBusinessDay: true } }))).toBe(
      "sale_date is a business day"
    );
  });
});

describe("rowsLimitedReason", () => {
  it("describes a filter from its grants' parts, naming only granted columns", () => {
    const rule: RowRule = {
      kind: "filter",
      filter: { c_secret: { in: ["A"] } },
      columns,
      descriptions: [
        part({ c_channel: { eq: "Retail" } }),
        part({ c_secret: { eq: "A" } }, null, "g2"),
      ],
    };
    expect(rowsLimitedReason(rule, granted, keyLabels)).toBe(
      "channel is Retail; or some rows only"
    );
  });

  it("says no rows for a rule that keeps none, and asks for an admin for one that cannot apply", () => {
    expect(rowsLimitedReason({ kind: "never" }, granted, keyLabels)).toBe(
      "no rows"
    );
    expect(
      rowsLimitedReason(
        { kind: "unavailable", reason: "column_missing" },
        granted,
        keyLabels
      )
    ).toBe("no rows right now; ask an admin");
  });
});

describe("describeRowRule with below", () => {
  it("says the caller's value or that of anyone who reports to them", () => {
    expect(
      say(part({ c_rep: { in: { identity: "k_emp", below: true } } }))
    ).toBe(
      "sales_rep is your NetSuite employee ID or that of anyone who reports to you"
    );
    expect(
      say(part({ c_rep: { eq: { identity: "k_emp", below: true } } }))
    ).toBe(
      "sales_rep is your NetSuite employee ID or that of anyone who reports to you"
    );
  });

  it("says none of them for notIn and ne", () => {
    expect(
      say(part({ c_rep: { notIn: { identity: "k_emp", below: true } } }))
    ).toBe(
      "sales_rep is none of your NetSuite employee ID or those of anyone who reports to you"
    );
  });

  it("names no one below the caller", () => {
    const rule: RowRule = {
      kind: "filter",
      filter: { c_rep: { in: ["u-report-1", "1042"] } },
      columns,
      descriptions: [
        part({ c_rep: { in: { identity: "k_emp", below: true } } }),
      ],
    };
    const text = rowsLimitedReason(rule, granted, keyLabels);
    expect(text).not.toMatch(/u-report-1|1042/);
  });

  it("says to try again shortly, not to ask an admin, when the hierarchy is unavailable", () => {
    expect(
      rowsLimitedReason(
        { kind: "unavailable", reason: "hierarchy_unavailable" },
        granted,
        keyLabels
      )
    ).toBe("no rows right now; try again shortly");
    expect(
      rowsLimitedReason(
        { kind: "unavailable", reason: "too_many_values" },
        granted,
        keyLabels
      )
    ).toBe("no rows right now; ask an admin");
  });
});
