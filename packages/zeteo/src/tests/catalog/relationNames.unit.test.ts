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

describe("discovered names follow the declared-name rules", () => {
  const NAME = /^[a-z][a-z0-9_]{0,62}$/;
  const fromTable = (table: string, columns: string[], to = "t") =>
    ({
      constraintName: "c",
      from: { schemaName: "s", table, columns },
      to: { schemaName: "s", table: to, columns: ["id"] },
    }) satisfies SnapshotForeignKey;

  it.each([
    [["CustomerRef"], "customer_ref"],
    [["ownerId"], "owner"],
    [["OwnerId"], "owner"],
    [["customer_id"], "customer"],
    [["Customer ID"], "customer_id"],
    [["a-b.c"], "a_b_c"],
    [["1st"], "r_1st"],
    [["_x"], "r__x"],
    [["éé"], "r___"],
  ])("forward name of %j is %s", (columns, want) => {
    const got = forwardName(fromTable("t", columns, "users"));
    expect(got).toBe(want);
    expect(got).toMatch(NAME);
  });

  it("lower-cases the target table's name when it stands in", () => {
    expect(forwardName(fromTable("t", ["id"], "Users"))).toBe("users");
  });

  it("falls back to `relation` for a name with nothing in it", () => {
    expect(reverseName(fromTable("", ["x"]))).toBe("relation");
  });

  it("splits camelCase tables in the reverse name", () => {
    expect(reverseName(fromTable("OrderLines", ["x"]))).toBe("order_lines");
  });

  it("keeps a 63-character base name valid when it collides", () => {
    const base = "a".repeat(63);
    expect(reverseName(fromTable(base, ["x"]))).toBe(base);
    const second = uniqueName(base, new Set([base]));
    expect(second).toHaveLength(63);
    expect(second.endsWith("_2")).toBe(true);
    expect(second).toMatch(NAME);
    const third = uniqueName(base, new Set([base, second]));
    expect(third).toHaveLength(63);
    expect(third.endsWith("_3")).toBe(true);
  });

  it("truncates a longer name to 63 characters", () => {
    expect(reverseName(fromTable("b".repeat(80), ["x"]))).toHaveLength(63);
  });
});
