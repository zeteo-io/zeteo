import type { MeasureRow, VisibleCatalog } from "../grants/visibleCatalog.js";
import { visibleMeasures } from "./visible.js";
import { db } from "../utils/db/index.js";

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
 * overlaid with `draft`: the draft is usable only when it plans against this
 * catalogue, exactly as a stored measure would be.
 */
export const withDraftMeasure = async (
  catalog: VisibleCatalog,
  draft: MeasureRow
): Promise<VisibleCatalog> => {
  const rows = overlayDraft(
    await db.measures.listBySource(catalog.source.id),
    draft
  );
  return { ...catalog, measures: visibleMeasures(catalog, rows) };
};
