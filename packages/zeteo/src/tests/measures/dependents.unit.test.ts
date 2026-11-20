// @module-tag unit
// @module-tag platform
import type { MeasureRow, MetricRow } from "../../grants/visibleCatalog.js";
import { tableRemoval } from "../../measures/dependents.js";
import { describe, expect, it } from "vitest";

const measure = (
  name: string,
  tableId: string,
  formula: unknown,
  extra: Partial<MeasureRow> = {}
): MeasureRow =>
  ({
    id: `m-${name}`,
    sourceId: "src",
    tableId,
    name,
    description: `The ${name}`,
    formula,
    where: null,
    fixed: false,
    dateColumn: null,
    ...extra,
  }) as MeasureRow;

const metric = (name: string, formula: unknown): MetricRow =>
  ({
    id: `x-${name}`,
    sourceId: "src",
    name,
    description: `The ${name}`,
    formula,
  }) as MetricRow;

const names = (rows: { name: string }[]) => rows.map((r) => r.name);

describe("tableRemoval", () => {
  const FX = measure("fx_rate", "rates", { avg: "rate" }, { fixed: true });
  const SPEND = measure("spend", "rates", { sum: "spend" });
  const REVENUE = measure("revenue_eur", "orders", {
    mul: [{ sum: "total" }, { measure: "fx_rate" }],
  });
  const NET = measure("net_eur", "orders", { measure: "revenue_eur" });
  const ROAS = metric("roas", {
    div: [{ measure: "revenue_eur" }, { measure: "spend" }],
  });
  const SPEND_X2 = metric("spend_x2", { mul: [{ measure: "spend" }, 2] });
  const ORDERS_ONLY = metric("orders_only", { measure: "net_eur" });

  it("blocks on a measure of another table using one of the table's, and on the metrics using it", () => {
    const removal = tableRemoval(
      "rates",
      [FX, SPEND, REVENUE, NET],
      [ROAS, SPEND_X2, ORDERS_ONLY]
    );
    expect(removal.blocking).toEqual([
      { kind: "measure", name: "net_eur" },
      { kind: "measure", name: "revenue_eur" },
      { kind: "metric", name: "orders_only" },
      { kind: "metric", name: "roas" },
    ]);
  });

  it("removes the table's measures and the metrics using them when nothing elsewhere uses them", () => {
    const removal = tableRemoval(
      "rates",
      [FX, SPEND, measure("own_eur", "rates", { measure: "fx_rate" })],
      [SPEND_X2, metric("fx_x2", { mul: [{ measure: "own_eur" }, 2] })]
    );
    expect(removal.blocking).toEqual([]);
    expect(names(removal.measures)).toEqual(["fx_rate", "own_eur", "spend"]);
    expect(names(removal.metrics)).toEqual(["fx_x2", "spend_x2"]);
  });

  it("finds a measure elsewhere that uses one of the table's only through another table's", () => {
    const removal = tableRemoval(
      "rates",
      [FX, REVENUE, NET, measure("third", "returns", { measure: "net_eur" })],
      []
    );
    expect(removal.blocking.map((b) => b.name)).toEqual([
      "net_eur",
      "revenue_eur",
      "third",
    ]);
  });

  it("lists nothing for a table without measures", () => {
    expect(tableRemoval("none", [FX, REVENUE], [ROAS])).toEqual({
      measures: [],
      metrics: [],
      blocking: [],
    });
  });
});
