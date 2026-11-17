// @module-tag unit
// @module-tag platform
import { CopySavedQuerySchema } from "../../../../routes/v1/saved-queries/saved-query/copy/schemas.js";
import { UpdateSavedQuerySchema } from "../../../../routes/v1/saved-queries/saved-query/schemas.js";
import { describe, expect, it } from "vitest";
import {
  CreateSavedQuerySchema,
  ListSavedQueriesQuerySchema,
} from "../../../../routes/v1/saved-queries/schemas.js";

const QUERY = { source: "s", from: "orders", select: ["id"] };
const create = (fields: Record<string, unknown>) =>
  CreateSavedQuerySchema.safeParse({ name: "n", query: QUERY, ...fields });

describe("CreateSavedQuerySchema", () => {
  it("accepts a name, an optional description and a query, and trims the name", () => {
    const parsed = create({ name: "  Orders  ", description: "d" });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ name: "Orders", description: "d" });
    expect(create({}).data?.description).toBe("");
  });

  it.each([
    ["an empty name", { name: "" }],
    ["a name of spaces", { name: "   " }],
    ["a name of 101 characters", { name: "a".repeat(101) }],
    ["a name with NUL", { name: "a\u0000b" }],
    ["a description of 2001 characters", { description: "a".repeat(2001) }],
    ["a description with NUL", { description: "a\u0000" }],
    ["a query that is not an object", { query: "select 1" }],
    ["a query that is a list", { query: [] }],
    ["an unknown key", { owner_id: "x" }],
  ])("refuses %s", (_, fields) => {
    expect(create(fields).success).toBe(false);
  });

  it("accepts the bounds", () => {
    expect(create({ name: "a".repeat(100) }).success).toBe(true);
    expect(create({ description: "a".repeat(2000) }).success).toBe(true);
    expect(create({ description: "" }).success).toBe(true);
  });

  it("refuses a missing name or query", () => {
    expect(CreateSavedQuerySchema.safeParse({ query: QUERY }).success).toBe(
      false
    );
    expect(CreateSavedQuerySchema.safeParse({ name: "n" }).success).toBe(false);
  });
});

describe("UpdateSavedQuerySchema", () => {
  it.each([
    [{ name: "n" }],
    [{ description: "" }],
    [{ query: QUERY }],
    [{ name: "n", description: "d", query: QUERY }],
  ])("accepts %j", (body) => {
    expect(UpdateSavedQuerySchema.safeParse(body).success).toBe(true);
  });

  it.each([
    ["an empty change", {}],
    ["an empty name", { name: "" }],
    ["a null description", { description: null }],
    ["a name with NUL", { name: "a\u0000" }],
    ["an unknown key", { name: "n", source_id: "x" }],
  ])("refuses %s", (_, body) => {
    expect(UpdateSavedQuerySchema.safeParse(body).success).toBe(false);
  });
});

describe("CopySavedQuerySchema", () => {
  it("takes a name, trimmed", () => {
    expect(CopySavedQuerySchema.parse({ name: " c " })).toEqual({ name: "c" });
  });
  it.each([[{}], [{ name: "" }], [{ name: "n", x: 1 }], [{ name: "a\u0000" }]])(
    "refuses %j",
    (body) => {
      expect(CopySavedQuerySchema.safeParse(body).success).toBe(false);
    }
  );
});

describe("ListSavedQueriesQuerySchema", () => {
  const ID = "0197d000-0000-7000-8000-000000000001";
  const list = (q: Record<string, unknown>) =>
    ListSavedQueriesQuerySchema.safeParse(q);

  it("defaults to mine, 50 a page", () => {
    expect(list({}).data).toMatchObject({ scope: "mine", limit: 50 });
  });
  it("accepts source_id and owner_id with all", () => {
    expect(list({ scope: "all", source_id: ID, owner_id: ID }).success).toBe(
      true
    );
  });
  it("accepts shared_with_type and shared_with_id together with all", () => {
    expect(
      list({ scope: "all", shared_with_type: "group", shared_with_id: ID }).data
    ).toMatchObject({ shared_with_type: "group", shared_with_id: ID });
  });
  it.each([
    ["source_id without all", { source_id: ID }],
    ["shared_with_type alone", { scope: "all", shared_with_type: "user" }],
    ["shared_with_id alone", { scope: "all", shared_with_id: ID }],
    [
      "shared_with_* without all",
      { scope: "mine", shared_with_type: "user", shared_with_id: ID },
    ],
    [
      "an unknown shared_with_type",
      { scope: "all", shared_with_type: "role", shared_with_id: ID },
    ],
    ["owner_id with shared", { scope: "shared", owner_id: ID }],
    ["an unknown scope", { scope: "x" }],
    ["limit 0", { limit: 0 }],
    ["limit 101", { limit: 101 }],
    ["an unknown key", { sort: "name" }],
    ["q with NUL", { q: "a\u0000" }],
  ])("refuses %s", (_, q) => {
    expect(list(q).success).toBe(false);
  });
});
