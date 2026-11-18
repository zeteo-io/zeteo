import { syncIntervalProblem } from "./syncInterval";
import { describe, expect, it } from "vitest";

describe("syncIntervalProblem", () => {
  it("accepts 15 to 1440", () => {
    for (const t of ["15", "60", "1440"])
      expect(syncIntervalProblem(t)).toBeUndefined();
  });
  it("refuses outside, empty and non-numeric values", () => {
    for (const t of ["14", "1441", "", "abc", "1.5"])
      expect(syncIntervalProblem(t)).toBe("Sync every is 15 to 1440 minutes.");
  });
});
