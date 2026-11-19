import type { Metric } from "../../prisma/generated/client/index.js";
import type { Broken, UsedBy } from "./measure.js";

/**
 * A metric in full: its definition, whether the caller may use it, and, for
 * editors and admins, what uses it; for those who see every metric, whether
 * it is broken.
 */
export const metricView = (
  row: Metric,
  extra: { usable: boolean; usedBy?: UsedBy; broken?: Broken | null }
) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  formula: row.formula,
  created_at: row.createdAt.toISOString(),
  updated_at: row.updatedAt.toISOString(),
  usable: extra.usable,
  ...(extra.usedBy !== undefined && { used_by: extra.usedBy }),
  ...(extra.broken !== undefined && { broken: extra.broken }),
});

/**
 * A metric an editor cannot fully see (a measure it uses is not theirs):
 * never its formula, which would name what the editor cannot see.
 */
export const redactedMetricView = (row: Metric) => ({
  name: row.name,
  description: row.description,
  usable: false as const,
});

export type MetricView = ReturnType<typeof metricView>;
export type RedactedMetricView = ReturnType<typeof redactedMetricView>;
