// @module-tag unit
// @module-tag platform
import type { SnapshotForeignKey } from "../../adapters/types.js";
import { describe, expect, it } from "vitest";
import {
  columnPrefixOf,
  forwardName,
  reverseName,
  uniqueName,
} from "../../catalog/relationNames.js";

const fk = (fromColumns: string[], toTable: string): SnapshotForeignKey => ({
  constraintName: "c",
  from: { schemaName: "sales", table: "orders", columns: fromColumns },
  to: { schemaName: "sales", table: toTable, columns: ["id"] },
});

const ONE = { keysToSameTarget: 1, columnPrefix: null };
const MANY = { keysToSameTarget: 2, columnPrefix: null };

describe("forwardName", () => {
  it("names a lone key after the target table", () => {
    expect(forwardName(fk(["productid"], "product"), ONE)).toBe("product");
    expect(forwardName(fk(["o_custkey"], "customer"), ONE)).toBe("customer");
    expect(forwardName(fk(["customer_id"], "customers"), ONE)).toBe(
      "customers"
    );
    expect(forwardName(fk(["a", "b"], "specialofferproduct"), ONE)).toBe(
      "specialofferproduct"
    );
  });

  it("drops the column prefix and key suffix when several keys share a target", () => {
    const ws = { keysToSameTarget: 2, columnPrefix: "ws_" };
    expect(forwardName(fk(["ws_sold_date_sk"], "date_dim"), ws)).toBe(
      "sold_date"
    );
    expect(forwardName(fk(["ws_ship_date_sk"], "date_dim"), ws)).toBe(
      "ship_date"
    );
  });

  it.each([
    [["bill_to_address_id"], "bill_to_address"],
    [["ship_to_address_id"], "ship_to_address"],
    [["ProductID"], "product"],
    [["ownerId"], "owner"],
    [["owner_fk"], "owner"],
    [["custkey"], "cust"],
    [["customer"], "customer"],
    [["id"], "address"],
    [["_id"], "address"],
    [["Id"], "address"],
  ])("a several-key column %j gives %s", (columns, want) => {
    expect(forwardName(fk(columns, "address"), MANY)).toBe(want);
  });

  it("names a multi-column key among several after the target and its first column", () => {
    expect(forwardName(fk(["a_id", "b_id"], "pairs"), MANY)).toBe("pairs_a");
  });
});

describe("columnPrefixOf", () => {
  it("is the shared part up to the first underscore", () => {
    expect(columnPrefixOf(["ws_a", "ws_b"])).toBe("ws_");
  });
  it("is null when a column differs or there is only one", () => {
    expect(columnPrefixOf(["ws_a", "b"])).toBeNull();
    expect(columnPrefixOf(["id"])).toBeNull();
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
    [["a-b.c"], "a_b_c"],
    [["1st"], "r_1st"],
    [["éé"], "r___"],
  ])("forward name of %j is %s", (columns, want) => {
    const got = forwardName(fromTable("t", columns, "users"), MANY);
    expect(got).toBe(want);
    expect(got).toMatch(NAME);
  });

  it("lower-cases the target table's name when it stands in", () => {
    expect(forwardName(fromTable("t", ["id"], "Users"), MANY)).toBe("users");
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
