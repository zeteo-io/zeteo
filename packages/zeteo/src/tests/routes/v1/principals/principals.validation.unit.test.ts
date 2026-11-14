// @module-tag unit
// @module-tag platform
import { LookupPrincipalsBodySchema } from "../../../../routes/v1/principals/lookup/schemas.js";
import { SearchPrincipalsQuerySchema } from "../../../../routes/v1/principals/schemas.js";
import { describe, expect, it } from "vitest";

const ID = "0197d000-0000-7000-8000-000000000001";

describe("SearchPrincipalsQuerySchema", () => {
  it("accepts the bounds and defaults limit to 10", () => {
    const min = SearchPrincipalsQuerySchema.parse({ type: "user", q: "ab" });
    expect(min.limit).toBe(10);
    for (const query of [
      { type: "group", q: "x".repeat(100), limit: "25" },
      { type: "user", q: "ab", limit: "1" },
    ]) {
      expect(SearchPrincipalsQuerySchema.safeParse(query).success).toBe(true);
    }
  });

  it.each([
    ["q of 1 character", { type: "user", q: "a" }],
    ["q of 101 characters", { type: "user", q: "x".repeat(101) }],
    ["no q", { type: "user" }],
    ["limit 0", { type: "user", q: "ab", limit: "0" }],
    ["limit 26", { type: "user", q: "ab", limit: "26" }],
    ["a type that is neither", { type: "robot", q: "ab" }],
    ["no type", { q: "ab" }],
    ["an unknown key", { type: "user", q: "ab", sort: "name" }],
  ])("refuses %s", (_, query) => {
    expect(SearchPrincipalsQuerySchema.safeParse(query).success).toBe(false);
  });
});

describe("LookupPrincipalsBodySchema", () => {
  const refs = (n: number) =>
    Array.from({ length: n }, () => ({ type: "user", id: ID }));

  it("accepts 1 and 100 principals", () => {
    expect(
      LookupPrincipalsBodySchema.safeParse({ principals: refs(1) }).success
    ).toBe(true);
    expect(
      LookupPrincipalsBodySchema.safeParse({ principals: refs(100) }).success
    ).toBe(true);
  });

  it.each([
    ["0 principals", { principals: [] }],
    ["101 principals", { principals: refs(101) }],
    ["an id that is no UUID", { principals: [{ type: "user", id: "nope" }] }],
    ["a type that is neither", { principals: [{ type: "robot", id: ID }] }],
    ["an unknown key", { principals: refs(1), extra: 1 }],
  ])("refuses %s", (_, body) => {
    expect(LookupPrincipalsBodySchema.safeParse(body).success).toBe(false);
  });
});
