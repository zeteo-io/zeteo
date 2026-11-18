// @module-tag unit
// @module-tag platform
import { emptyColumnsWarning } from "../../uploads/warnings.js";
import { describe, expect, it } from "vitest";

describe("emptyColumnsWarning", () => {
  it("says nothing when every column has values", () => {
    expect(emptyColumnsWarning([])).toBeNull();
  });

  it("names one empty column", () => {
    expect(emptyColumnsWarning(["note"])).toBe(
      'Column "note" has no values in its first rows.'
    );
  });

  it("names every empty column in one warning", () => {
    expect(emptyColumnsWarning(["slack_channel_id", "teams_channel_id"])).toBe(
      'Columns "slack_channel_id", "teams_channel_id" have no values in their first rows.'
    );
  });
});
