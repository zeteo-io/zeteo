import type {
  Measure,
  Metric,
  RedactedMeasure,
  RedactedMetric,
} from "./api/types";

export const makeMeasure = (over: Partial<Measure> = {}): Measure => ({
  id: "m1111111-1c7a-4a53-9d0e-6a3b1f2c4d01",
  name: "paid_revenue",
  description: "Revenue of paid orders",
  table: "orders",
  formula: { op: "sum", column: "amount" },
  where: null,
  fixed: false,
  date_column: null,
  created_at: "2026-11-01T10:00:00.000Z",
  updated_at: "2026-11-01T10:00:00.000Z",
  usable: true,
  used_by: { saved_queries: 2, panels: 1 },
  broken: null,
  ...over,
});

export const makeRedactedMeasure = (
  over: Partial<RedactedMeasure> = {}
): RedactedMeasure => ({
  name: "margin",
  description: "Gross margin",
  table: "orders",
  usable: false,
  ...over,
});

export const makeMetric = (over: Partial<Metric> = {}): Metric => ({
  id: "e1111111-1c7a-4a53-9d0e-6a3b1f2c4d01",
  name: "margin_pct",
  description: "Margin as a share of revenue",
  formula: {
    div: [{ measure: "paid_revenue" }, { measure: "total_cost" }],
  },
  created_at: "2026-11-01T10:00:00.000Z",
  updated_at: "2026-11-01T10:00:00.000Z",
  usable: true,
  used_by: { saved_queries: 1, panels: 0 },
  broken: null,
  ...over,
});

export const makeRedactedMetric = (
  over: Partial<RedactedMetric> = {}
): RedactedMetric => ({
  name: "churn",
  description: "Customers lost",
  usable: false,
  ...over,
});
