import type { MetricRow } from "../../grants/visibleCatalog.js";

// Metrics are not stored yet: every source has none until their table exists.

/** Every metric of a source, by name. */
export const listBySource = async (
  _sourceId: string
): Promise<MetricRow[]> => [];
