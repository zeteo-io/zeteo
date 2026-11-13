import { describe, expect, it } from "vitest";
import { ZeteoError } from "../errors.js";
import { buildPath } from "../paths.js";

describe("buildPath", () => {
  it("fills and encodes parameters", () => {
    expect(
      buildPath("/v1/sources/{sourceId}/tables/{tableId}", {
        sourceId: "a b",
        tableId: "t%1",
      })
    ).toBe("/v1/sources/a%20b/tables/t%251");
  });

  it.each(["", "a/b", ".", "..", "a?b", "a#b", "a\\b"])(
    "refuses %j with invalid_id",
    (value) => {
      let error: unknown;
      try {
        buildPath("/v1/sources/{sourceId}", { sourceId: value });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(ZeteoError);
      expect(error).toMatchObject({ status: null, code: "invalid_id" });
    }
  );

  it("refuses a missing parameter", () => {
    expect(() => buildPath("/v1/grants/{grantId}", {})).toThrow(ZeteoError);
  });
});
