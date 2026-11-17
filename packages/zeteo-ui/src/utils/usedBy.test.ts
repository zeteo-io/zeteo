import { isUsed, usedByWarning } from "./usedBy";
import { describe, expect, it } from "vitest";

describe("usedByWarning", () => {
  it("names dashboards and saved panels for a saved query", () => {
    expect(usedByWarning({ dashboards: 2, saved_panels: 3 })).toBe(
      "Used by 2 dashboards and 3 saved panels. They'll change too."
    );
    expect(usedByWarning({ dashboards: 1, saved_panels: 1 })).toBe(
      "Used by 1 dashboard and 1 saved panel. They'll change too."
    );
  });

  it("names dashboards alone for a saved panel", () => {
    expect(usedByWarning({ dashboards: 4 })).toBe(
      "Used by 4 dashboards. They'll change too."
    );
  });

  it("is used only with a count above zero", () => {
    expect(isUsed(undefined)).toBe(false);
    expect(isUsed({ dashboards: 0, saved_panels: 0 })).toBe(false);
    expect(isUsed({ dashboards: 0, saved_panels: 1 })).toBe(true);
  });
});
