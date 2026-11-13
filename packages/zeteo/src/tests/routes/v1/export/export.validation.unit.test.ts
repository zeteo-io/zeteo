// @module-tag unit
// @module-tag platform
import { ExportQuerySchema } from "../../../../routes/v1/export/schemas.js";
import { describe, expect, it } from "vitest";

describe("ExportQuerySchema", () => {
  it.each([
    [{}, "ndjson"],
    [{ format: "ndjson" }, "ndjson"],
    [{ format: "csv" }, "csv"],
  ])("accepts %j as %s", (query, format) => {
    expect(ExportQuerySchema.parse(query)).toEqual({ format });
  });

  it.each([
    { format: "xml" },
    { format: "CSV" },
    { format: "" },
    { format: ["csv", "ndjson"] },
    { format: "csv", gzip: "1" },
  ])("refuses %j", (query) => {
    expect(ExportQuerySchema.safeParse(query).success).toBe(false);
  });
});
