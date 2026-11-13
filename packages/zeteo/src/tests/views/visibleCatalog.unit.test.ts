// @module-tag unit
// @module-tag platform
import type { VisibleCatalog } from "../../grants/visibleCatalog.js";
import { describe, expect, it } from "vitest";
import {
  visibleCatalogView,
  visibleCatalogViews,
} from "../../views/visibleCatalog.js";

const table = (id: string, schemaName: string, name: string) => ({
  id,
  schemaName,
  name,
  kind: "table" as const,
  description: null,
  missing: false,
  columns: [],
});

const relation = (id: string, name: string, toTableId: string) => ({
  id,
  name,
  fromTableId: "orders",
  fromColumns: ["x"],
  toTableId,
  toColumns: ["y"],
  toMany: false,
  missing: false,
});

const catalog = (over: Partial<VisibleCatalog> = {}): VisibleCatalog => ({
  source: {
    id: "s1",
    slug: "sales",
    name: "Sales",
    type: "postgres",
    timeoutMs: 1000,
    rowCap: 50,
  },
  tables: [
    table("orders", "public", "orders"),
    table("customers", "public", "customers"),
    table("items", "archive", "customers"),
  ],
  relations: [
    relation("r3", "zeta", "customers"),
    relation("r1", "alpha", "items"),
    relation("r2", "mid", "customers"),
    relation("r4", "ghost", "unknown"),
  ],
  ...over,
});

describe("visibleCatalogView", () => {
  it("lists each table's relations by name and names their targets as a query would", () => {
    const view = visibleCatalogView(catalog(), {});
    const orders = view.tables.find((t) => t.name === "orders");
    expect(orders?.relations.map((r) => [r.name, r.to])).toEqual([
      ["alpha", "archive.customers"],
      ["mid", "public.customers"],
      ["zeta", "public.customers"],
    ]);
  });
});

describe("visibleCatalogViews", () => {
  it("skips a source whose type has no adapter instead of failing the listing", () => {
    const broken = catalog({
      source: { ...catalog().source, slug: "old", type: "mysql" as never },
    });
    const views = visibleCatalogViews([broken, catalog()], () => ({}));
    expect(views.map((v) => v.slug)).toEqual(["sales"]);
  });
});
