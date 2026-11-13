// @module-tag unit
// @module-tag platform
import { PatchTableSchema } from "../../../../../../../routes/v1/sources/source/tables/table/schemas.js";
import { describe, expect, it } from "vitest";

describe("PatchTableSchema", () => {
  it("accepts descriptions and column names without NUL", () => {
    expect(
      PatchTableSchema.safeParse({
        description: "Orders",
        columns: [{ name: "total", description: "Gross" }],
      }).success
    ).toBe(true);
  });

  it.each([
    ["the table description", { description: "Or\u0000ders" }],
    [
      "a column description",
      { columns: [{ name: "total", description: "Gr\u0000oss" }] },
    ],
    [
      "a column name",
      { columns: [{ name: "to\u0000tal", description: "Gross" }] },
    ],
  ])("refuses a NUL character in %s", (_, body) => {
    expect(PatchTableSchema.safeParse(body).success).toBe(false);
  });
});
