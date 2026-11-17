// @module-tag unit
// @module-tag platform
import { placePanel } from "../../dashboards/layout.js";
import { describe, expect, it } from "vitest";

describe("placePanel", () => {
  it("puts the first panel in the corner", () => {
    expect(placePanel([], { w: 6, h: 4 })).toEqual({ x: 0, y: 0 });
  });

  it("goes right of a panel when there is room, then below", () => {
    const first = { x: 0, y: 0, w: 6, h: 4 };
    expect(placePanel([first], { w: 6, h: 4 })).toEqual({ x: 6, y: 0 });
    expect(
      placePanel([first, { x: 6, y: 0, w: 6, h: 4 }], { w: 6, h: 4 })
    ).toEqual({ x: 0, y: 4 });
  });

  it("starts a full-width panel on a free row", () => {
    expect(placePanel([{ x: 0, y: 0, w: 3, h: 2 }], { w: 12, h: 4 })).toEqual({
      x: 0,
      y: 2,
    });
  });

  it("fills a gap an earlier panel left, scanning rows then columns", () => {
    const cells = [
      { x: 0, y: 0, w: 3, h: 2 },
      { x: 6, y: 0, w: 6, h: 2 },
      { x: 0, y: 2, w: 12, h: 2 },
    ];
    expect(placePanel(cells, { w: 3, h: 2 })).toEqual({ x: 3, y: 0 });
    expect(placePanel(cells, { w: 4, h: 2 })).toEqual({ x: 0, y: 4 });
  });

  it("finds the first place that fits the height, not only the first free cell", () => {
    const cells = [
      { x: 0, y: 0, w: 6, h: 1 },
      { x: 0, y: 2, w: 6, h: 1 },
    ];
    // Row 1 of the left half is one cell high: a tall panel goes to the right instead.
    expect(placePanel(cells, { w: 6, h: 2 })).toEqual({ x: 6, y: 0 });
  });

  it("cuts a width over the grid to it", () => {
    expect(placePanel([], { w: 20, h: 1 })).toEqual({ x: 0, y: 0 });
  });
});
