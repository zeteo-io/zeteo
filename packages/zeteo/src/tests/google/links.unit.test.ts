// @module-tag unit
// @module-tag platform

import { InvalidSheetLinkError } from "../../utils/errors.js";
import { parseSheetLink } from "../../google/links.js";
import { describe, expect, it } from "vitest";

const id = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms";

describe("parseSheetLink", () => {
  it("accepts the address-bar link", () => {
    expect(parseSheetLink(`https://docs.google.com/spreadsheets/d/${id}`)).toBe(
      id
    );
  });

  it("accepts a link with /edit#gid=0", () => {
    expect(
      parseSheetLink(
        `https://docs.google.com/spreadsheets/d/${id}/edit?usp=sharing#gid=0`
      )
    ).toBe(id);
    expect(
      parseSheetLink(
        `  https://docs.google.com/spreadsheets/d/${id}/edit#gid=0 `
      )
    ).toBe(id);
  });

  it("accepts a bare id", () => {
    expect(parseSheetLink(id)).toBe(id);
  });

  it.each([
    ["http", `http://docs.google.com/spreadsheets/d/${id}/edit`],
    ["another host", `https://evil.example/spreadsheets/d/${id}/edit`],
    [
      "a lookalike host",
      `https://docs.google.com.evil.example/spreadsheets/d/${id}`,
    ],
    ["a document", `https://docs.google.com/document/d/${id}/edit`],
    [
      "a published link",
      `https://docs.google.com/spreadsheets/d/e/2PACX-${id}/pubhtml`,
    ],
    ["a short id", "abc123"],
    ["an empty string", ""],
    ["text", "my spreadsheet"],
  ])("refuses %s with invalid_sheet_link", (_name, input) => {
    expect(() => parseSheetLink(input)).toThrowError(InvalidSheetLinkError);
    try {
      parseSheetLink(input);
    } catch (err) {
      const e = err as InvalidSheetLinkError;
      expect(e.statusCode).toBe(422);
      expect(e.code).toBe("invalid_sheet_link");
      expect(e.message).toBe(
        "Paste the link from the sheet's address bar or its Share dialog."
      );
    }
  });
});
