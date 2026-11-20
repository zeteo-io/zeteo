import { shopCatalog, type ShopOptions } from "./shopCatalog.js";
import type {
  MeasureRow,
  MetricRow,
  VisibleCatalog,
} from "../../../grants/visibleCatalog.js";

// The shop with measures that carry date columns, on several tables, and
// metrics over them: the shapes of ROAS and Projected Landing.

export const measure = (
  name: string,
  formula: unknown,
  options: {
    table?: string;
    where?: unknown;
    fixed?: boolean;
    dateColumn?: string | null;
  } = {}
): MeasureRow =>
  ({
    id: `m-${name}`,
    sourceId: "src",
    tableId: options.table ?? "orders",
    name,
    description: `The ${name}`,
    formula,
    where: options.where ?? null,
    fixed: options.fixed ?? false,
    dateColumn: options.dateColumn === undefined ? null : options.dateColumn,
  }) as MeasureRow;

export const metric = (name: string, formula: unknown): MetricRow =>
  ({
    id: `x-${name}`,
    sourceId: "src",
    name,
    description: `The ${name}`,
    formula,
  }) as MetricRow;

export const MEASURES: MeasureRow[] = [
  measure("revenue", { sum: "total" }, { dateColumn: "ordered_on" }),
  measure(
    "paid_revenue",
    { sum: "total" },
    { dateColumn: "ordered_on", where: { status: { eq: "paid" } } }
  ),
  measure("revenue_at", { sum: "total" }, { dateColumn: "created_at" }),
  // Through a to-one relation, on another table.
  measure(
    "line_value",
    { sum: "price" },
    { table: "order_lines", dateColumn: "product.launched_on" }
  ),
  measure(
    "spend",
    { sum: "cost" },
    { table: "products", dateColumn: "launched_on" }
  ),
  measure(
    "signups",
    { count: "*" },
    { table: "customers", dateColumn: "created_at" }
  ),
  measure("undated", { count: "*" }),
  measure("last_order_on", { max: "ordered_on" }, { dateColumn: "ordered_on" }),
  measure(
    "top_balance",
    { max: "balance" },
    { table: "billing_accounts", fixed: true }
  ),
  measure(
    "secret_cost",
    { sum: "cost" },
    { table: "products", dateColumn: "launched_on" }
  ),
];

export const METRICS: MetricRow[] = [
  metric("roas", { div: [{ measure: "revenue" }, { measure: "spend" }] }),
  metric("landing", {
    add: [
      { measure: "revenue" },
      {
        mul: [
          { measure: "top_balance" },
          { businessDaysInMonth: { date: "2026-06-01" } },
        ],
      },
    ],
  }),
  metric("paid_share", {
    round: [
      {
        div: [
          { coalesce: [{ measure: "paid_revenue" }, 0] },
          { measure: "revenue" },
        ],
      },
      2,
    ],
  }),
  metric("secret_roas", {
    div: [{ measure: "revenue" }, { measure: "secret_cost" }],
  }),
];

/** The shop with these measures and metrics; `products.cost` hidden makes `spend`, `secret_cost` and their metrics invisible. */
export const metricsCatalog = (
  options: ShopOptions = {},
  extra: { measures?: MeasureRow[]; metrics?: MetricRow[] } = {}
): VisibleCatalog =>
  shopCatalog({
    ...options,
    measures: [...MEASURES, ...(extra.measures ?? [])],
    metrics: [...METRICS, ...(extra.metrics ?? [])],
  });
