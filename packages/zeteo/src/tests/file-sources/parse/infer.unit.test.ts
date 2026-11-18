// @module-tag unit
// @module-tag platform

import { describe, expect, it } from "vitest";
import {
  detectHeaderRow,
  inferType,
  TypeInferrer,
} from "../../../file-sources/parse/infer.js";

describe("inferType", () => {
  it("keeps leading-zero ZIPs as text", () => {
    expect(inferType(["02134", "10001"])).toBe("text");
    expect(inferType(["007"])).toBe("text");
  });

  it("infers number for 1, 2.5, -3", () => {
    expect(inferType(["1", "2.5", "-3"])).toBe("number");
    expect(inferType(["0", "0.5", "-0.25", "1e3"])).toBe("number");
  });

  it("falls back to text when any value is not a number", () => {
    expect(inferType(["1", "two"])).toBe("text");
    expect(inferType(["1,000"])).toBe("text");
  });

  it("ISO dates are date", () => {
    expect(inferType(["2024-01-05", "2024-12-31"])).toBe("date");
    expect(inferType(["2024-02-30"])).toBe("text");
    expect(inferType(["01/05/2024"])).toBe("text");
  });

  it("ISO timestamps are timestamp, and mixing with dates gives timestamp", () => {
    expect(
      inferType(["2024-01-05T10:00:00Z", "2024-01-05 10:00:00+02:00"])
    ).toBe("timestamp");
    expect(inferType(["2024-01-05", "2024-01-05T10:00:00Z"])).toBe("timestamp");
  });

  it("boolean only for true/false", () => {
    expect(inferType(["true", "FALSE", "False"])).toBe("boolean");
  });

  it("yes/no stays text", () => {
    expect(inferType(["yes", "no"])).toBe("text");
  });

  it("ignores nulls, and all-null is text", () => {
    expect(inferType([null, "1", null])).toBe("number");
    expect(inferType([null, null])).toBe("text");
    expect(inferType([])).toBe("text");
  });
});

describe("detectHeaderRow", () => {
  it("is row 0 when text headers sit over typed columns", () => {
    expect(
      detectHeaderRow([
        ["name", "age"],
        ["Ann", "30"],
      ])
    ).toBe(0);
  });

  it("is row 0 for an all-text file", () => {
    expect(
      detectHeaderRow([
        ["a", "b"],
        ["x", "y"],
      ])
    ).toBe(0);
  });

  it("is row 0 when row 0 has an empty cell", () => {
    expect(
      detectHeaderRow([
        ["name", null],
        ["Ann", "30"],
      ])
    ).toBe(0);
  });

  it("is null when row 0 is numbers above numbers", () => {
    expect(
      detectHeaderRow([
        ["1", "2"],
        ["3", "4"],
      ])
    ).toBeNull();
  });

  it("is null when row 0 is a date above dates", () => {
    expect(
      detectHeaderRow([
        ["x", "2024-01-01"],
        ["y", "2024-02-01"],
      ])
    ).toBeNull();
  });

  it("is row 0 for a number header above text, or no rows below", () => {
    expect(
      detectHeaderRow([
        ["2024", "b"],
        ["x", "y"],
      ])
    ).toBe(0);
    expect(detectHeaderRow([["name", "age"]])).toBe(0);
  });

  it("is null for no rows", () => {
    expect(detectHeaderRow([])).toBeNull();
  });
});

describe("TypeInferrer", () => {
  it("agrees with inferType when fed one value at a time", () => {
    const cases: (string | null)[][] = [
      ["1", "2.5", null, "-3"],
      ["2024-01-01", "2024-01-02T10:00:00Z"],
      ["true", "False"],
      ["1", "x"],
      ["007", "1"],
      [],
    ];
    for (const values of cases) {
      const inferrer = new TypeInferrer();
      for (const v of values) inferrer.add(v);
      expect(inferrer.type).toBe(inferType(values));
    }
  });
});
