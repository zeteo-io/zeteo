// @module-tag unit
// @module-tag platform
import type { VisibleCatalog } from "../../grants/visibleCatalog.js";
import { DEFAULT_CALENDAR } from "../../calendar/calendar.js";
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
  lastSyncedAt: null as Date | null,
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
    description: "",
    type: "postgres",
    timeoutMs: 1000,
    rowCap: 50,
    maxJoins: 4,
    exportEnabled: false,
    exportRowCap: 0,
    queryConcurrency: 5,
    exportConcurrency: 2,
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
  calendar: DEFAULT_CALENDAR,
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

describe("visibleCatalogView upload sources", () => {
  it("shows last_loaded_at for an upload table, null for a database table, and the source kind", () => {
    const at = new Date("2026-11-17T10:00:00.000Z");
    const upload = visibleCatalogView(
      catalog({
        source: { ...catalog().source, type: "upload" },
        tables: [{ ...table("t", "zu_a", "people"), lastSyncedAt: at }],
        relations: [],
      }),
      {}
    );
    expect(upload.kind).toBe("upload");
    expect(upload.tables[0]?.last_loaded_at).toBe(at.toISOString());
    const db = visibleCatalogView(catalog(), {});
    expect(db.kind).toBe("database");
    expect(db.tables.every((t) => t.last_loaded_at === null)).toBe(true);
  });
});

describe("visibleCatalogView limits", () => {
  it.each([
    [false, 0, { enabled: false, max_rows: 0 }],
    [false, 500, { enabled: false, max_rows: 0 }],
    [true, 0, { enabled: false, max_rows: 0 }],
    [true, 500, { enabled: true, max_rows: 500 }],
  ])(
    "shows exports on %s with a cap of %i as %j",
    (exportEnabled, exportRowCap, expected) => {
      const view = visibleCatalogView(
        catalog({
          source: { ...catalog().source, exportEnabled, exportRowCap },
        }),
        {}
      );
      expect(view.limits.export).toEqual(expected);
    }
  );
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
