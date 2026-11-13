// @module-tag unit
// @module-tag platform
// @module-tag security
import { sqlQuerySchema } from "../../../adapters/sql/language.js";
import { planSql } from "../../../adapters/sql/plan.js";
import { QueryError } from "../../../engine/errors.js";
import { describe, expect, it } from "vitest";
import {
  shopCatalog,
  type ShopOptions,
} from "../../support/pure/shopCatalog.js";

// A name the caller may not see must fail exactly as one the source does not
// have: the same query planned over the caller's view with the name hidden,
// and over a source without it, throws the same error; a name that exists
// nowhere throws it too, but for the name itself; and no suggestion is ever a
// hidden name.

/** Everything a caller receives about the error. */
const errorOf = (query: object, options: ShopOptions) => {
  try {
    planSql(
      sqlQuerySchema.parse({
        source: "shop",
        from: "orders",
        select: ["id"],
        ...query,
      }),
      shopCatalog(options)
    );
  } catch (err) {
    if (!(err instanceof QueryError)) throw err;
    return {
      status: err.statusCode,
      code: err.code,
      message: err.message,
      details: err.details,
    };
  }
  throw new Error("the query was planned");
};

/** Replaces the name, wherever it is a whole JSON string or a path segment, everywhere in the query. */
const rename = (query: object, from: string, to: string): object =>
  JSON.parse(
    JSON.stringify(query).replace(
      new RegExp(`(?<=[".])${from}(?=["])`, "g"),
      to
    )
  ) as object;

const NOWHERE = "nowhere_at_all";

const CASES: Array<[string, object, hidden: string, name: string]> = [
  ["a selected column", { select: ["notes"] }, "orders.notes", "notes"],
  [
    "a column through a relation",
    { join: ["customer"], select: ["customer.email"] },
    "customers.email",
    "email",
  ],
  [
    "an aggregate's column",
    { select: [{ sum: "total" }] },
    "orders.total",
    "total",
  ],
  [
    "a bucket's column",
    { select: [{ bucket: "month", column: "created_at" }] },
    "orders.created_at",
    "created_at",
  ],
  [
    "a where column",
    { where: { notes: { eq: "x" } } },
    "orders.notes",
    "notes",
  ],
  [
    "a column in nested and/or/not",
    {
      where: {
        and: [
          { id: { gt: 1 } },
          { or: [{ status: { eq: "a" } }, { not: { notes: { eq: "x" } } }] },
        ],
      },
    },
    "orders.notes",
    "notes",
  ],
  [
    "a groupBy entry",
    { select: ["status", { count: "*" }], groupBy: ["status", "notes"] },
    "orders.notes",
    "notes",
  ],
  [
    "an orderBy column",
    { select: ["id"], orderBy: [{ notes: "asc" }] },
    "orders.notes",
    "notes",
  ],
  [
    "a join whose key is hidden",
    { join: ["customer"] },
    "customers.id",
    "customer",
  ],
  [
    "a join whose own-side key is hidden",
    { join: ["lines"] },
    "order_lines.order_id",
    "lines",
  ],
  ["a table in from", { from: "customers" }, "customers", "customers"],
  // json refusals come after the name resolves, so they cannot tell hidden from absent.
  [
    "a json column in countDistinct",
    { from: "customers", select: [{ countDistinct: "prefs" }] },
    "customers.prefs",
    "prefs",
  ],
  [
    "a json column in orderBy",
    { from: "customers", select: ["id"], orderBy: [{ prefs: "asc" }] },
    "customers.prefs",
    "prefs",
  ],
];

const HIDDEN_NAMES = (hidden: string) => [hidden, hidden.split(".").at(-1)!];

describe("planSql: hidden names", () => {
  it.each(CASES)(
    "fails on %s exactly as when the source does not have it",
    (_, query, hidden) => {
      expect(errorOf(query, { hidden: [hidden] })).toEqual(
        errorOf(query, { absent: [hidden] })
      );
    }
  );

  it.each(CASES)(
    "fails on %s as on a name that exists nowhere",
    (_, query, hidden, name) => {
      const seen = errorOf(query, { hidden: [hidden] });
      const nowhere = errorOf(rename(query, name, NOWHERE), {
        hidden: [hidden],
      });
      expect(nowhere.code).toBe(seen.code);
      expect(nowhere.status).toBe(seen.status);
      expect(nowhere.message.replaceAll(NOWHERE, name)).toBe(seen.message);
      expect(nowhere.details?.path).toEqual(
        (seen.details?.path as unknown[]).map((p) => (p === name ? NOWHERE : p))
      );
      for (const suggestion of seen.details?.suggestions as string[]) {
        expect(HIDDEN_NAMES(hidden)).not.toContain(
          suggestion.split(".").at(-1)
        );
      }
    }
  );

  it.each([
    ["a column", { select: ["statu"] }, ["orders.status"], "status"],
    [
      "a column through a relation",
      { join: ["customer"], select: ["customer.emal"] },
      ["customers.email"],
      "customer.email",
    ],
    ["a table", { from: "custmers" }, ["customers"], "customers"],
    ["a relation", { join: ["custmer"] }, ["customers.id"], "customer"],
  ])("never suggests a hidden %s", (_, query, hidden, name) => {
    // Visible, the name is suggested, so the test bites.
    expect(errorOf(query, {}).details?.suggestions).toContain(name);
    const unseen = errorOf(query, { hidden });
    expect(unseen.code).toBe("not_found_or_not_accessible");
    expect(unseen.details?.suggestions).not.toContain(name);
  });

  it("does not count a hidden table when deciding a bare name is ambiguous", () => {
    expect(errorOf({ from: "accounts" }, {}).details?.suggestions).toEqual([
      "billing.accounts",
      "shop.accounts",
    ]);
    // With billing.accounts hidden, `accounts` resolves and the column fails.
    expect(
      errorOf(
        { from: "accounts", select: ["nope"] },
        { hidden: ["billing_accounts"] }
      ).details?.path
    ).toEqual(["select", 0]);
  });
});
