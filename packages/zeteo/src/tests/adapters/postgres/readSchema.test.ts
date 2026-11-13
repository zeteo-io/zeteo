// @module-tag int
// @module-tag platform
import { fixtureSettings, fixtureTarget } from "../../support/fixtureDb.js";
import { postgresAdapter } from "../../../adapters/postgres/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  SchemaSnapshot,
  SourceConnection,
} from "../../../adapters/types.js";

let connection: SourceConnection;
let snapshot: SchemaSnapshot;

const table = (name: string) =>
  snapshot.tables.find((t) => t.schemaName === "sales" && t.name === name)!;
const column = (tableName: string, name: string) =>
  table(tableName).columns.find((c) => c.name === name)!;

beforeAll(async () => {
  connection = await postgresAdapter.connect(
    fixtureSettings("ro"),
    await fixtureTarget(),
    { connectTimeoutMs: 5000, poolSize: 2, queryTimeoutMs: 5000 }
  );
  snapshot = await connection.readSchema(["sales", "hr"]);
});

afterAll(async () => {
  await connection.close();
});

describe("postgres readSchema", () => {
  it("lists the tables and the view the login can read", () => {
    const found = snapshot.tables
      .map((t) => `${t.schemaName}.${t.name}:${t.kind}`)
      .sort();
    expect(found).toEqual([
      "sales.blobs:table",
      "sales.customers:table",
      "sales.order_lines:table",
      "sales.orders:table",
      "sales.paid_orders:view",
    ]);
  });

  it("returns nothing from a schema the login cannot read", () => {
    expect(snapshot.tables.some((t) => t.schemaName === "hr")).toBe(false);
  });

  it("never returns a system schema, even when listed", async () => {
    const result = await connection.readSchema([
      "pg_catalog",
      "information_schema",
      "pg_toast",
    ]);
    expect(result).toEqual({ tables: [], foreignKeys: [] });
  });

  it("maps native types to normalised types", () => {
    expect(column("orders", "total")).toMatchObject({
      type: "number",
      nativeType: "numeric",
    });
    expect(column("orders", "created_at").type).toBe("timestamp");
    expect(column("orders", "status").type).toBe("text");
    expect(column("blobs", "data").type).toBe("other");
    expect(column("blobs", "tags").type).toBe("other");
  });

  it("reports nullability and positions", () => {
    expect(column("customers", "name").nullable).toBe(false);
    expect(column("customers", "region").nullable).toBe(true);
    expect(table("customers").columns.map((c) => c.position)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it("flags primary-key columns in position order", () => {
    const keys = table("order_lines")
      .columns.filter((c) => c.isPrimaryKey)
      .map((c) => c.name);
    expect(keys).toEqual(["order_id", "line_no"]);
    expect(table("blobs").columns.some((c) => c.isPrimaryKey)).toBe(false);
  });

  it("returns the foreign keys between listed relations", () => {
    expect(snapshot.foreignKeys).toHaveLength(2);
    expect(snapshot.foreignKeys).toContainEqual(
      expect.objectContaining({
        from: {
          schemaName: "sales",
          table: "order_lines",
          columns: ["order_id"],
        },
        to: { schemaName: "sales", table: "orders", columns: ["id"] },
      })
    );
    expect(snapshot.foreignKeys).toContainEqual(
      expect.objectContaining({
        from: {
          schemaName: "sales",
          table: "orders",
          columns: ["customer_id"],
        },
        to: { schemaName: "sales", table: "customers", columns: ["id"] },
      })
    );
  });
});
