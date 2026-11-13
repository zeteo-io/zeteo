// @module-tag unit
// @module-tag platform
import { buildVisibleCatalog } from "../../grants/visibleCatalog.js";
import type { Access } from "../../grants/access.js";
import { describe, expect, it } from "vitest";
import type {
  Relation,
  Source,
  SourceColumn,
  SourceTable,
} from "../../../prisma/generated/client/index.js";

const source = {
  id: "s1",
  slug: "sales",
  name: "Sales",
  type: "azure_sql",
  timeoutMs: 1000,
  rowCap: 50,
  exportEnabled: true,
  exportRowCap: 1000,
} as Source;

const table = (id: string, name: string, missing = false): SourceTable =>
  ({
    id,
    sourceId: "s1",
    schemaName: "public",
    name,
    kind: "table",
    description: null,
    missingSince: missing ? new Date() : null,
  }) as SourceTable;

const column = (
  id: string,
  tableId: string,
  name: string,
  position: number,
  missing = false
): SourceColumn =>
  ({
    id,
    tableId,
    name,
    type: "text",
    nativeType: "text",
    nullable: false,
    position,
    isPrimaryKey: false,
    description: null,
    missingSince: missing ? new Date() : null,
  }) as SourceColumn;

const relation = (over: Partial<Relation> = {}): Relation =>
  ({
    id: "r1",
    sourceId: "s1",
    name: "customer",
    fromTableId: "orders",
    fromColumns: ["customer_id"],
    toTableId: "customers",
    toColumns: ["id"],
    toMany: false,
    missingSince: null,
    ...over,
  }) as Relation;

const accessFor = (grants: Record<string, "all" | string[]>): Access => {
  const held = new Map(
    Object.entries(grants).map(([t, g]) => [
      t,
      g === "all" ? ("all" as const) : new Set(g),
    ])
  );
  return {
    sourceIds: new Set(["s1"]),
    tableAccess: (t) => held.get(t),
    allows: (t, c) => {
      const g = held.get(t);
      return g === "all" || (g?.has(c) ?? false);
    },
  };
};

const tables = [table("orders", "orders"), table("customers", "customers")];
const columns = [
  column("o1", "orders", "id", 1),
  column("o2", "orders", "customer_id", 2),
  column("o3", "orders", "total", 3),
  column("c1", "customers", "id", 1),
  column("c2", "customers", "email", 2),
];

describe("buildVisibleCatalog", () => {
  it("shows only the granted columns and tables with at least one", () => {
    const catalog = buildVisibleCatalog(
      source,
      tables,
      columns,
      [],
      accessFor({ orders: ["o1", "o3"] })
    );
    expect(catalog.tables.map((t) => t.name)).toEqual(["orders"]);
    expect(catalog.tables[0].columns.map((c) => c.name)).toEqual([
      "id",
      "total",
    ]);
    expect(catalog.source).toEqual({
      id: "s1",
      slug: "sales",
      name: "Sales",
      type: "azure-sql",
      timeoutMs: 1000,
      rowCap: 50,
      exportEnabled: true,
      exportRowCap: 1000,
    });
  });

  it("hides a column added after an explicit grant, but shows it under all_columns", () => {
    const added = [...columns, column("o4", "orders", "discount", 4)];
    const listed = buildVisibleCatalog(
      source,
      tables,
      added,
      [],
      accessFor({ orders: ["o1", "o2", "o3"] })
    );
    expect(listed.tables[0].columns.map((c) => c.name)).not.toContain(
      "discount"
    );
    const all = buildVisibleCatalog(
      source,
      tables,
      added,
      [],
      accessFor({ orders: "all" })
    );
    expect(all.tables[0].columns.map((c) => c.name)).toContain("discount");
  });

  it("keeps a relation only while every key column on both sides is granted", () => {
    const rels = [relation()];
    const granted = { orders: ["o2"], customers: ["c1"] };
    expect(
      buildVisibleCatalog(source, tables, columns, rels, accessFor(granted))
        .relations
    ).toHaveLength(1);
    expect(
      buildVisibleCatalog(
        source,
        tables,
        columns,
        rels,
        accessFor({ ...granted, orders: ["o3"] })
      ).relations
    ).toEqual([]);
    expect(
      buildVisibleCatalog(
        source,
        tables,
        columns,
        rels,
        accessFor({ ...granted, customers: ["c2"] })
      ).relations
    ).toEqual([]);
  });

  it("drops a relation when its table is not visible", () => {
    expect(
      buildVisibleCatalog(
        source,
        tables,
        columns,
        [relation()],
        accessFor({ orders: "all" })
      ).relations
    ).toEqual([]);
  });

  it("drops a relation that names a column no row has", () => {
    const rels = [relation({ fromColumns: ["customer_ref"] })];
    expect(
      buildVisibleCatalog(
        source,
        tables,
        columns,
        rels,
        accessFor({ orders: "all", customers: "all" })
      ).relations
    ).toEqual([]);
  });

  it("keeps missing tables, columns and relations, marked", () => {
    const catalog = buildVisibleCatalog(
      source,
      [table("orders", "orders", true), tables[1]],
      [
        column("o1", "orders", "id", 1, true),
        column("c1", "customers", "id", 1),
      ],
      [
        relation({
          fromColumns: ["id"],
          toColumns: ["id"],
          missingSince: new Date(),
        }),
      ],
      accessFor({ orders: "all", customers: "all" })
    );
    expect(catalog.tables.find((t) => t.name === "orders")).toMatchObject({
      missing: true,
      columns: [{ name: "id", missing: true }],
    });
    expect(catalog.relations[0].missing).toBe(true);
  });
});
