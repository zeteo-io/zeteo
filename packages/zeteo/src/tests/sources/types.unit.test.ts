// @module-tag unit
// @module-tag platform
import { describe, expect, it } from "vitest";
import {
  isFileUpload,
  isSheetsSource,
  isUploadSource,
  storedType,
  typeOf,
} from "../../sources/types.js";

describe("source types", () => {
  it("isUploadSource is true for upload and google_sheets", () => {
    expect(isUploadSource({ type: "upload" })).toBe(true);
    expect(isUploadSource({ type: "google_sheets" })).toBe(true);
    expect(isUploadSource({ type: "postgres" })).toBe(false);
    expect(isUploadSource({ type: "azure_sql" })).toBe(false);
  });

  it("isSheetsSource is true only for google_sheets", () => {
    expect(isSheetsSource({ type: "google_sheets" })).toBe(true);
    expect(isSheetsSource({ type: "upload" })).toBe(false);
    expect(isSheetsSource({ type: "postgres" })).toBe(false);
  });

  it("isFileUpload is true only for upload", () => {
    expect(isFileUpload({ type: "upload" })).toBe(true);
    expect(isFileUpload({ type: "google_sheets" })).toBe(false);
  });

  it("typeOf maps google_sheets to google-sheets", () => {
    expect(typeOf({ type: "google_sheets" })).toBe("google-sheets");
    expect(typeOf({ type: "azure_sql" })).toBe("azure-sql");
    expect(typeOf({ type: "upload" })).toBe("upload");
  });

  it("storedType maps back", () => {
    expect(storedType("google-sheets")).toBe("google_sheets");
    expect(storedType("azure-sql")).toBe("azure_sql");
    expect(storedType("postgres")).toBe("postgres");
  });
});
