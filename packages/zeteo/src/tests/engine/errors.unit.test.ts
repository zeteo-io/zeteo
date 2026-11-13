// @module-tag unit
// @module-tag platform
import { QueryError, notFound } from "../../engine/errors.js";
import { describe, expect, it } from "vitest";

describe("QueryError", () => {
  it("answers 422 with the path and suggestions in the body", () => {
    const err = new QueryError("invalid_value", "bad", ["where", "id", "eq"]);
    expect(err.statusCode).toBe(422);
    expect(err.code).toBe("invalid_value");
    expect(err.details).toEqual({
      path: ["where", "id", "eq"],
      suggestions: [],
    });
  });
});

describe("notFound", () => {
  it("builds the one not-found error, naming what was asked for", () => {
    const err = notFound(
      "column",
      "customer.regoin",
      ["select", 0],
      ["customer.region"]
    );
    expect(err).toBeInstanceOf(QueryError);
    expect(err.code).toBe("not_found_or_not_accessible");
    expect(err.message).toBe(
      'Column "customer.regoin" was not found or is not accessible'
    );
    expect(err.details).toEqual({
      path: ["select", 0],
      suggestions: ["customer.region"],
    });
  });

  it("suggests at most three candidates, closest first, ties alphabetical", () => {
    const err = notFound(
      "table",
      "abc",
      ["from"],
      ["abx", "xbc", "ab", "abcd", "zzz", "aab"]
    );
    expect(err.suggestions).toEqual(["ab", "abcd", "abx"]);
  });

  it("measures closeness on the last segment's length, not the whole path's", () => {
    const err = notFound(
      "column",
      "customer.regoin",
      ["select", 0],
      ["customer.region", "customer.name", "customer.email"]
    );
    expect(err.suggestions).toEqual(["customer.region"]);
  });

  it("cuts a long name in the message", () => {
    const err = notFound("column", "x".repeat(1000), ["select", 0], []);
    expect(err.message.length).toBeLessThan(200);
  });
});
