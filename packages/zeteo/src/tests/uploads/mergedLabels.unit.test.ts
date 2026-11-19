// @module-tag unit
// @module-tag platform
import { suggestLabels } from "../../uploads/mergedLabels.js";
import { describe, expect, it } from "vitest";

describe("suggestLabels", () => {
  it("suggestLabels on the five real titles", () => {
    const p = "FBA Inventory - Updates Every Hour - Amazon Inventory - ";
    const names = [
      "Watermelon Ball",
      "Rak Pro Tools",
      "ChomChom",
      "Cooler Shock",
      "VIVO",
    ];
    const labels = suggestLabels(
      names.map((n, i) => ({ tableId: `t${i}`, title: p + n }))
    );
    expect(Object.values(labels)).toEqual(names);
  });
  it("suggestLabels with no common part keeps titles", () => {
    expect(
      suggestLabels([
        { tableId: "a", title: "Alpha" },
        { tableId: "b", title: "Beta" },
      ])
    ).toEqual({ a: "Alpha", b: "Beta" });
  });
  it("a single member, or identical titles, keep the title", () => {
    expect(suggestLabels([{ tableId: "a", title: "Only" }])).toEqual({
      a: "Only",
    });
    expect(
      suggestLabels([
        { tableId: "a", title: "Same" },
        { tableId: "b", title: "Same" },
      ])
    ).toEqual({ a: "Same", b: "Same" });
  });
});
