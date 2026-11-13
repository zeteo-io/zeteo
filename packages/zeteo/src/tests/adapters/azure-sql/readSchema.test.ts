// @module-tag int
// @module-tag platform
import { azureSqlAdapter } from "../../../adapters/azure-sql/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  asMssqlAdmin,
  mssqlFixtureSettings,
  mssqlFixtureTarget,
} from "../../support/mssqlFixture.js";
import type {
  SchemaSnapshot,
  SourceConnection,
} from "../../../adapters/types.js";

const options = { connectTimeoutMs: 5000, poolSize: 2, queryTimeoutMs: 10_000 };

let connection: SourceConnection;
let snapshot: SchemaSnapshot;

const table = (name: string) =>
  snapshot.tables.find((t) => t.schemaName === "sales" && t.name === name)!;
const column = (tableName: string, name: string) =>
  table(tableName).columns.find((c) => c.name === name)!;

beforeAll(async () => {
  connection = await azureSqlAdapter.connect(
    mssqlFixtureSettings("ro"),
    await mssqlFixtureTarget(),
    options
  );
  snapshot = await connection.readSchema(["sales", "hr"]);
});

afterAll(async () => {
  await connection.close();
});

describe("azure-sql readSchema", () => {
  it("lists the tables and the views the login can read, and no other object", () => {
    const found = snapshot.tables
      .map((t) => `${t.schemaName}.${t.name}:${t.kind}`)
      .sort();
    expect(found).toEqual([
      "sales.accounts:table",
      "sales.broken_orders:view",
      "sales.customers:table",
      "sales.order_lines:table",
      "sales.orders:table",
      "sales.paid_orders:view",
      "sales.slow_orders:view",
    ]);
  });

  it("returns nothing from a schema the login is denied", () => {
    expect(snapshot.tables.some((t) => t.schemaName === "hr")).toBe(false);
  });

  it("never returns a system schema, even when listed", async () => {
    const result = await connection.readSchema([
      "sys",
      "INFORMATION_SCHEMA",
      "guest",
      "db_owner",
      "db_datareader",
      "SYS",
    ]);
    expect(result).toEqual({ tables: [], foreignKeys: [] });
  });

  it("matches schema names exactly", async () => {
    expect(await connection.readSchema(["SALES"])).toEqual({
      tables: [],
      foreignKeys: [],
    });
  });

  it("treats a schema name carrying SQL as a name", async () => {
    const hostile = [
      "sales'; DROP TABLE sales.accounts; --",
      "sales]; DROP TABLE sales.accounts; --",
      "@s0",
      "sales",
    ];
    const result = await connection.readSchema(hostile);
    expect(result.tables.map((t) => t.schemaName)).toEqual(
      Array(7).fill("sales")
    );
    const again = await connection.readSchema(["sales"]);
    expect(again.tables.map((t) => t.name)).toContain("accounts");
  });

  it("maps native types to normalised types and readable native types", () => {
    expect(column("orders", "total")).toMatchObject({
      type: "number",
      nativeType: "decimal(12,2)",
    });
    expect(column("orders", "created_at")).toMatchObject({
      type: "timestamp",
      nativeType: "datetimeoffset(6)",
    });
    expect(column("orders", "status")).toMatchObject({
      type: "text",
      nativeType: "nvarchar(200)",
    });
    expect(column("orders", "external_ref")).toMatchObject({
      type: "number",
      nativeType: "bigint",
    });
    expect(column("orders", "id")).toMatchObject({
      type: "number",
      nativeType: "int",
    });
    expect(column("broken_orders", "ratio").type).toBe("number");
  });

  it("reports nullability and positions", () => {
    expect(column("customers", "name").nullable).toBe(false);
    expect(column("customers", "region").nullable).toBe(true);
    expect(table("customers").columns.map((c) => [c.position, c.name])).toEqual(
      [
        [1, "id"],
        [2, "name"],
        [3, "region"],
        [4, "email"],
        [5, "account_id"],
      ]
    );
  });

  it("flags primary-key columns in position order", () => {
    const keys = table("order_lines")
      .columns.filter((c) => c.isPrimaryKey)
      .map((c) => c.name);
    expect(keys).toEqual(["order_id", "line_no"]);
    expect(table("paid_orders").columns.some((c) => c.isPrimaryKey)).toBe(
      false
    );
  });

  it("returns the foreign keys between listed relations, with their names", () => {
    expect(
      [...snapshot.foreignKeys].sort((a, b) =>
        a.constraintName.localeCompare(b.constraintName)
      )
    ).toEqual([
      {
        constraintName: "customers_account_id_fkey",
        from: {
          schemaName: "sales",
          table: "customers",
          columns: ["account_id"],
        },
        to: { schemaName: "sales", table: "accounts", columns: ["id"] },
      },
      {
        constraintName: "order_lines_order_id_fkey",
        from: {
          schemaName: "sales",
          table: "order_lines",
          columns: ["order_id"],
        },
        to: { schemaName: "sales", table: "orders", columns: ["id"] },
      },
      {
        constraintName: "orders_customer_id_fkey",
        from: {
          schemaName: "sales",
          table: "orders",
          columns: ["customer_id"],
        },
        to: { schemaName: "sales", table: "customers", columns: ["id"] },
      },
    ]);
  });
});

describe("azure-sql readSchema foreign keys", () => {
  it("returns only keys whose both ends the login can read", async () => {
    await asMssqlAdmin(["DENY SELECT ON sales.customers TO zeteo_ro"]);
    try {
      const result = await connection.readSchema(["sales"]);
      expect(result.tables.map((t) => t.name)).not.toContain("customers");
      expect(result.foreignKeys.map((k) => k.constraintName)).toEqual([
        "order_lines_order_id_fkey",
      ]);
    } finally {
      await asMssqlAdmin(["REVOKE SELECT ON sales.customers FROM zeteo_ro"]);
    }
  });
});
