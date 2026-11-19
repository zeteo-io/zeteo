import type { Measure, RedactedMeasure } from "./api/types";

export const makeMeasure = (over: Partial<Measure> = {}): Measure => ({
  id: "m1111111-1c7a-4a53-9d0e-6a3b1f2c4d01",
  name: "paid_revenue",
  description: "Revenue of paid orders",
  table: "orders",
  formula: { op: "sum", column: "amount" },
  where: null,
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
