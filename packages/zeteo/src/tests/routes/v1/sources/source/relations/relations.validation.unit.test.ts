// @module-tag unit
// @module-tag platform
import { DeclareRelationSchema } from "../../../../../../routes/v1/sources/source/relations/schemas.js";
import { describe, expect, it } from "vitest";

const relation = {
  name: "by_region",
  from_table_id: "0198f7a2-0000-7000-8000-000000000001",
  from_columns: ["region"],
  to_table_id: "0198f7a2-0000-7000-8000-000000000002",
  to_columns: ["region"],
  to_many: true,
};

describe("DeclareRelationSchema", () => {
  it("accepts a relation without NUL", () => {
    expect(DeclareRelationSchema.safeParse(relation).success).toBe(true);
  });

  it.each([
    ["the name", { name: "by\u0000region" }],
    ["a from column", { from_columns: ["re\u0000gion"] }],
    ["a to column", { to_columns: ["re\u0000gion"] }],
  ])("refuses a NUL character in %s", (_, change) => {
    expect(
      DeclareRelationSchema.safeParse({ ...relation, ...change }).success
    ).toBe(false);
  });
});
