// @module-tag unit
// @module-tag platform

import { cellText, type SheetCell } from "../../google/cells.js";
import { describe, expect, it } from "vitest";

const num = (numberValue: number, type?: string): SheetCell => ({
  effectiveValue: { numberValue },
  ...(type ? { effectiveFormat: { numberFormat: { type } } } : {}),
});

describe("cellText", () => {
  it("DATE serial 45292 is 2024-01-01", () => {
    expect(cellText(num(45292, "DATE"), "America/Chicago")).toBe("2024-01-01");
  });

  it("DATE_TIME serial 45292.75 in America/Chicago is 2024-01-02T00:00:00.000Z", () => {
    expect(cellText(num(45292.75, "DATE_TIME"), "America/Chicago")).toBe(
      "2024-01-02T00:00:00.000Z"
    );
  });

  it("DATE_TIME across a DST change uses that day's offset", () => {
    // 2024-07-01 18:00 wall time: CDT is UTC-5.
    expect(cellText(num(45474.75, "DATE_TIME"), "America/Chicago")).toBe(
      "2024-07-01T23:00:00.000Z"
    );
    // 2024-03-10 03:30 wall time, just after the spring-forward: CDT.
    expect(
      cellText(num(45361 + 3.5 / 24, "DATE_TIME"), "America/Chicago")
    ).toBe("2024-03-10T08:30:00.000Z");
  });

  it("a DATE_TIME at midnight UTC stays a timestamp (Sheets says it is one)", () => {
    expect(cellText(num(45292, "DATE_TIME"), "UTC")).toBe(
      "2024-01-01T00:00:00.000Z"
    );
  });

  it("a wall time inside a DST gap resolves forward (02:30 becomes 03:30 CDT)", () => {
    expect(
      cellText(num(45361 + 2.5 / 24, "DATE_TIME"), "America/Chicago")
    ).toBe("2024-03-10T08:30:00.000Z");
  });

  it("a repeated wall time takes the earlier instant", () => {
    // 2024-11-03 01:30 happens twice in Chicago; the first is CDT (UTC-5).
    expect(
      cellText(num(45599 + 1.5 / 24, "DATE_TIME"), "America/Chicago")
    ).toBe("2024-11-03T06:30:00.000Z");
  });

  it("an out-of-range serial stays its number", () => {
    expect(cellText(num(1e9, "DATE"), "UTC")).toBe("1000000000");
    expect(cellText(num(1e12, "DATE_TIME"), "UTC")).toBe("1000000000000");
  });

  it("serials at the edge of years 0001-9999 render, and just outside stay numbers", () => {
    expect(cellText(num(-693593, "DATE"), "UTC")).toBe("0001-01-01");
    expect(cellText(num(2958465, "DATE"), "UTC")).toBe("9999-12-31");
    expect(cellText(num(-693594, "DATE"), "UTC")).toBe("-693594");
    expect(cellText(num(2958466, "DATE"), "UTC")).toBe("2958466");
    expect(cellText(num(-693593, "DATE_TIME"), "UTC")).toBe(
      "0001-01-01T00:00:00.000Z"
    );
    expect(cellText(num(2958465.5, "DATE_TIME"), "UTC")).toBe(
      "9999-12-31T12:00:00.000Z"
    );
    expect(cellText(num(-693593.5, "DATE_TIME"), "UTC")).toBe("-693593.5");
    expect(cellText(num(2958466, "DATE_TIME"), "UTC")).toBe("2958466");
  });

  it("far out-of-range and non-finite serials stay numbers", () => {
    expect(cellText(num(3000000, "DATE"), "UTC")).toBe("3000000");
    expect(cellText(num(-700000, "DATE"), "UTC")).toBe("-700000");
    expect(cellText(num(100025569, "DATE_TIME"), "UTC")).toBe("100025569");
    expect(cellText(num(-99974430, "DATE_TIME"), "UTC")).toBe("-99974430");
  });

  it("an edge serial pushed outside year 9999 by the zone stays a number", () => {
    expect(cellText(num(2958465.99, "DATE_TIME"), "America/Chicago")).toBe(
      "2958465.99"
    );
  });

  it("DATE_TIME east of UTC", () => {
    expect(cellText(num(45292.5, "DATE_TIME"), "Asia/Kolkata")).toBe(
      "2024-01-01T06:30:00.000Z"
    );
  });

  it("an unknown time zone is refused for a DATE_TIME only", () => {
    expect(() => cellText(num(45292.5, "DATE_TIME"), "Mars/Base")).toThrow(
      RangeError
    );
    expect(cellText(num(45292, "DATE"), "Mars/Base")).toBe("2024-01-01");
  });

  it("TIME stays a number", () => {
    expect(cellText(num(0.75, "TIME"), "UTC")).toBe("0.75");
  });

  it("a percent stays a number", () => {
    expect(cellText(num(0.25, "PERCENT"), "UTC")).toBe("0.25");
    expect(cellText(num(42), "UTC")).toBe("42");
  });

  it("boolean", () => {
    expect(cellText({ effectiveValue: { boolValue: true } }, "UTC")).toBe(
      "true"
    );
    expect(cellText({ effectiveValue: { boolValue: false } }, "UTC")).toBe(
      "false"
    );
  });

  it("strings are kept as is", () => {
    expect(cellText({ effectiveValue: { stringValue: " a b " } }, "UTC")).toBe(
      " a b "
    );
  });

  it("error and empty are null", () => {
    expect(
      cellText({ effectiveValue: { errorValue: { type: "DIV_ZERO" } } }, "UTC")
    ).toBeNull();
    expect(cellText({ effectiveValue: { stringValue: "" } }, "UTC")).toBeNull();
    expect(cellText({}, "UTC")).toBeNull();
    expect(cellText(undefined, "UTC")).toBeNull();
  });

  it("a formula's effectiveValue is used", () => {
    expect(
      cellText(
        {
          effectiveValue: { numberValue: 6 },
          formattedValue: "=1+5",
        } as SheetCell,
        "UTC"
      )
    ).toBe("6");
  });
});
