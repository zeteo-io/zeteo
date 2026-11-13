// @module-tag unit
// @module-tag platform
import { TableCursorSchema } from "../../../../../../routes/v1/sources/source/tables/schemas.js";
import { describe, expect, it } from "vitest";

describe("TableCursorSchema", () => {
  it("accepts a schema and a table name", () => {
    expect(TableCursorSchema.safeParse(["sales", "orders"]).success).toBe(true);
  });

  it.each([
    ["the schema name", ["sa\u0000les", "orders"]],
    ["the table name", ["sales", "or\u0000ders"]],
  ])("refuses a NUL character in %s", (_, values) => {
    expect(TableCursorSchema.safeParse(values).success).toBe(false);
  });
});
