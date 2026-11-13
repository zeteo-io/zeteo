// @module-tag unit
// @module-tag platform
import { normaliseValue } from "../../../adapters/sql/values.js";
import { describe, expect, it } from "vitest";

describe("normaliseValue", () => {
  it("keeps null as null for every wire kind", () => {
    for (const wire of [
      "int64",
      "decimal",
      "number",
      "boolean",
      "date",
      "timestamp",
      "json",
      "text",
    ] as const) {
      expect(normaliseValue(null, wire)).toBeNull();
    }
  });

  it.each([
    ["42", 42],
    ["-32768", -32768],
    ["0.30000000000000004", 0.30000000000000004],
    ["1e+300", 1e300],
    ["NaN", "NaN"],
    ["Infinity", "Infinity"],
    ["-Infinity", "-Infinity"],
  ])("reads number %s as %s", (raw, wire) => {
    expect(normaliseValue(raw, "number")).toBe(wire);
  });

  it("keeps 64-bit integers and decimals exactly as the database printed them", () => {
    expect(normaliseValue("9223372036854775807", "int64")).toBe(
      "9223372036854775807"
    );
    expect(normaliseValue("12345678901234567890.123456789", "decimal")).toBe(
      "12345678901234567890.123456789"
    );
    expect(normaliseValue("1.10", "decimal")).toBe("1.10");
    expect(normaliseValue("NaN", "decimal")).toBe("NaN");
  });

  it("reads booleans", () => {
    expect(normaliseValue("t", "boolean")).toBe(true);
    expect(normaliseValue("f", "boolean")).toBe(false);
  });

  it("keeps a date as YYYY-MM-DD, and passes infinity and BC dates through", () => {
    expect(normaliseValue("2026-03-31", "date")).toBe("2026-03-31");
    expect(normaliseValue("infinity", "date")).toBe("infinity");
    expect(normaliseValue("0044-03-15 BC", "date")).toBe("0044-03-15 BC");
  });

  it.each([
    ["2026-03-31 23:59:59.123456", "2026-03-31T23:59:59.123Z"],
    ["2026-03-31 23:59:59.9999", "2026-03-31T23:59:59.999Z"],
    ["2026-03-31 23:59:59", "2026-03-31T23:59:59.000Z"],
    ["2026-03-31 23:59:59.5", "2026-03-31T23:59:59.500Z"],
    ["2026-03-31 21:59:59.987654+00", "2026-03-31T21:59:59.987Z"],
    ["2026-03-31 23:59:59.987654+02", "2026-03-31T21:59:59.987Z"],
    ["2026-01-01 00:00:00-03:30", "2026-01-01T03:30:00.000Z"],
    ["1999-12-31 23:00:00-05", "2000-01-01T04:00:00.000Z"],
    ["0099-01-01 00:00:00", "0099-01-01T00:00:00.000Z"],
    ["2026-01-01 00:00:00+05:53:28", "2025-12-31T18:06:32.000Z"],
  ])("reads timestamp %s as %s", (raw, wire) => {
    expect(normaliseValue(raw, "timestamp")).toBe(wire);
  });

  it("passes infinite and BC timestamps through as the database printed them", () => {
    expect(normaliseValue("infinity", "timestamp")).toBe("infinity");
    expect(normaliseValue("-infinity", "timestamp")).toBe("-infinity");
    expect(normaliseValue("0001-01-01 00:00:00 BC", "timestamp")).toBe(
      "0001-01-01 00:00:00 BC"
    );
  });

  it("parses json and keeps text", () => {
    expect(normaliseValue('{"a": [1, 2]}', "json")).toEqual({ a: [1, 2] });
    expect(normaliseValue("null", "json")).toBeNull();
    expect(normaliseValue('"text"', "json")).toBe("text");
    expect(normaliseValue("100% Organic_Foods", "text")).toBe(
      "100% Organic_Foods"
    );
  });
});
