import { MeasureError, expandMeasure } from "../adapters/sql/measures.js";
import { planSql, queryNameOf } from "../adapters/sql/plan.js";
import { QueryError } from "../engine/errors.js";
import type {
  MeasureRow,
  VisibleCatalog,
  VisibleMeasure,
} from "../grants/visibleCatalog.js";

// The grant rule: a caller sees a measure only when its home table, every
// column it reads and every relation it joins, through the measures it uses
// too, are in their catalogue. That is decided by planning the measure alone
// from its home table against the caller's catalogue, so it is exactly the
// rule a query using it is held to; whatever fails, the measure is absent.

/**
 * The catalogue as it would be if nothing were missing from the source. A
 * missing column is still granted, so a measure reading one stays visible and
 * a query using it is told `missing_in_source`; deciding with missing flags
 * would stop at the first missing column and could pass over an ungranted one.
 */
const withNothingMissing = (
  catalog: Omit<VisibleCatalog, "measures">
): Omit<VisibleCatalog, "measures"> => ({
  ...catalog,
  tables: catalog.tables.map((t) => ({
    ...t,
    missing: false,
    columns: t.columns.map((c) => ({ ...c, missing: false })),
  })),
  relations: catalog.relations.map((r) => ({ ...r, missing: false })),
});

const toVisible = (row: MeasureRow): VisibleMeasure => ({
  id: row.id,
  name: row.name,
  description: row.description,
  tableId: row.tableId,
  formula: row.formula,
  where: row.where,
  fixed: row.fixed,
  dateColumn: row.dateColumn,
});

/**
 * The measures of `rows` the caller of `catalog` may use: each plans cleanly
 * alone from its home table, and so does every measure it uses. Each row is
 * planned once; expansion stops at cycles and at the nesting limit, so this
 * never recurses without end.
 */
export const visibleMeasures = (
  catalog: Omit<VisibleCatalog, "measures">,
  rows: readonly MeasureRow[],
  /** Told of a failure that is not a planner's refusal, such as a malformed stored formula. */
  onUnexpected: (err: unknown, measureId: string) => void = () => {}
): VisibleMeasure[] => {
  const candidates = rows
    .filter((r) => r.sourceId === catalog.source.id)
    .map(toVisible);
  if (candidates.length === 0) return [];
  const byName = new Map(candidates.map((m) => [m.name, m]));
  const probe = { ...withNothingMissing(catalog), measures: candidates };
  const now = new Date();

  const plans = new Map<string, boolean>();
  const plansAlone = (m: VisibleMeasure): boolean => {
    const known = plans.get(m.name);
    if (known !== undefined) return known;
    const home = probe.tables.find((t) => t.id === m.tableId);
    let ok = false;
    if (home) {
      try {
        planSql(
          {
            source: catalog.source.slug,
            from: queryNameOf(probe.tables, home),
            select: [{ measure: m.name }],
          },
          probe,
          { now }
        );
        ok = true;
      } catch (err) {
        // Any failure hides it: a broken measure is not one the caller can
        // use. One the planner did not mean is reported, but hidden all the same.
        if (!(err instanceof QueryError) && !(err instanceof MeasureError)) {
          onUnexpected(err, m.id);
        }
      }
    }
    plans.set(m.name, ok);
    return ok;
  };

  return candidates.filter((m) => {
    if (!plansAlone(m)) return false;
    // Defence in depth: planning a measure plans the measures it uses, so
    // each of them plans alone too; this holds whatever the planner does.
    const { uses } = expandMeasure(m.name, m.tableId, byName);
    return uses.every((name) => {
      const used = byName.get(name);
      return used !== undefined && plansAlone(used);
    });
  });
};
