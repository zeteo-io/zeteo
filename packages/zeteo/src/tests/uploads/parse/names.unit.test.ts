// @module-tag unit
// @module-tag platform

import { normalizeName } from "../../../uploads/parse/names.js";
import { describe, expect, it } from "vitest";

describe("normalizeName", () => {
  it('normalizes "Order ID" to order_id', () => {
    expect(normalizeName("Order ID", new Set(), 0)).toBe("order_id");
    expect(normalizeName("  Total ($) ", new Set(), 0)).toBe("total");
    expect(normalizeName("Café Ünït", new Set(), 0)).toBe("cafe_unit");
  });

  it("dedupes repeated headers", () => {
    const taken = new Set<string>();
    expect(normalizeName("Amount", taken, 0)).toBe("amount");
    expect(normalizeName("amount", taken, 1)).toBe("amount_2");
    expect(normalizeName("AMOUNT", taken, 2)).toBe("amount_3");
  });

  it("blank header becomes column_3", () => {
    expect(normalizeName("", new Set(), 2)).toBe("column_3");
    expect(normalizeName("  !! ", new Set(), 2)).toBe("column_3");
  });

  it("starts with a letter", () => {
    expect(normalizeName("2024 sales", new Set(), 0)).toBe("column_2024_sales");
  });

  it("caps at 63 bytes, suffixes included", () => {
    const taken = new Set<string>();
    const long = "a".repeat(100);
    const first = normalizeName(long, taken, 0);
    const second = normalizeName(long, taken, 1);
    expect(first).toHaveLength(63);
    expect(second).toHaveLength(63);
    expect(second.endsWith("_2")).toBe(true);
    expect(second).not.toBe(first);
  });
});
