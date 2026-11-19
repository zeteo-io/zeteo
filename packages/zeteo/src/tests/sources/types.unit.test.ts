// @module-tag unit
// @module-tag platform
import { isUploadSource, storedType, typeOf } from "../../sources/types.js";
import { describe, expect, it } from "vitest";

describe("source types", () => {
  it("isUploadSource is true only for upload", () => {
    expect(isUploadSource({ type: "upload" })).toBe(true);
    expect(isUploadSource({ type: "postgres" })).toBe(false);
    expect(isUploadSource({ type: "azure_sql" })).toBe(false);
  });

  it("typeOf maps azure_sql to azure-sql", () => {
    expect(typeOf({ type: "azure_sql" })).toBe("azure-sql");
    expect(typeOf({ type: "upload" })).toBe("upload");
  });

  it("storedType maps back", () => {
    expect(storedType("azure-sql")).toBe("azure_sql");
    expect(storedType("postgres")).toBe("postgres");
  });
});
