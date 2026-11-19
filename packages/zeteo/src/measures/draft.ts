import { visibleMeasures, visibleMetrics } from "./visible.js";
import { db } from "../utils/db/index.js";
import type {
  MeasureRow,
  MetricRow,
  VisibleCatalog,
} from "../grants/visibleCatalog.js";

/**
 * The stored measures of a source with `draft` in place of the one it
 * replaces: the stored row with its id or its name, if there is one.
 */
export const overlayDraft = (
  rows: readonly MeasureRow[],
  draft: MeasureRow
): MeasureRow[] => [
  ...rows.filter((r) => r.id !== draft.id && r.name !== draft.name),
  draft,
];

/**
 * `catalog` with its measures decided again over the source's stored measures
 * overlaid with `draft`, and its metrics over them: the draft is usable only
 * when it plans against this catalogue, exactly as a stored measure would be.
 */
export const withDraftMeasure = async (
  catalog: VisibleCatalog,
  draft: MeasureRow
): Promise<VisibleCatalog> => {
  const [stored, metrics] = await Promise.all([
    db.measures.listBySource(catalog.source.id),
    db.metrics.listBySource(catalog.source.id),
  ]);
  const measures = visibleMeasures(catalog, overlayDraft(stored, draft));
  return {
    ...catalog,
    measures,
    metrics: visibleMetrics({ source: catalog.source, measures }, metrics),
  };
};

/**
 * `catalog` with its metrics decided again over the source's stored metrics
 * with `draft` in place of the one of its id or name: the draft is usable only
 * when every measure it names is the caller's, as a stored metric would be.
 */
export const withDraftMetric = async (
  catalog: VisibleCatalog,
  draft: MetricRow
): Promise<VisibleCatalog> => {
  const stored = await db.metrics.listBySource(catalog.source.id);
  const rows = [
    ...stored.filter((r) => r.id !== draft.id && r.name !== draft.name),
    draft,
  ];
  return { ...catalog, metrics: visibleMetrics(catalog, rows) };
};
