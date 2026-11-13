// @module-tag unit
// @module-tag platform
import type { SnapshotForeignKey } from "../../adapters/types.js";
import { describe, expect, it } from "vitest";
import {
  forwardName,
  reverseName,
  uniqueName,
} from "../../catalog/relationNames.js";

const fk = (fromColumns: string[], toTable: string): SnapshotForeignKey => ({
  constraintName: "c",
  from: { schemaName: "sales", table: "orders", columns: fromColumns },
  to: { schemaName: "sales", table: toTable, columns: ["id"] },
});

describe("forwardName", () => {
  it.each([
    [["customer_id"], "customers", "customer"],
    [["ownerId"], "users", "owner"],
    [["owner_fk"], "users", "owner"],
    [["id"], "users", "users"],
    [["_id"], "users", "users"],
    [["Id"], "users", "users"],
    [["a_id", "b_id"], "pairs", "pairs"],
    [["customer"], "customers", "customer"],
  ])("%j to %s gives %s", (columns, table, want) => {
    expect(forwardName(fk(columns, table))).toBe(want);
  });
});

describe("reverseName", () => {
  it("is the from table's name", () => {
    expect(reverseName(fk(["customer_id"], "customers"))).toBe("orders");
  });
});

describe("uniqueName", () => {
  it("keeps a free name", () => {
    expect(uniqueName("orders", new Set(["lines"]))).toBe("orders");
  });
  it("appends _2, then _3, on collision", () => {
    expect(uniqueName("orders", new Set(["orders"]))).toBe("orders_2");
    expect(uniqueName("orders", new Set(["orders", "orders_2"]))).toBe(
      "orders_3"
    );
  });
});
