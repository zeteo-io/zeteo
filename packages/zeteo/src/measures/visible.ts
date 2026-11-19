import { MeasureError, expandMeasure } from "../adapters/sql/measures.js";
import { QueryError } from "../engine/errors.js";
import type {
  MeasureRow,
  MetricRow,
  VisibleCatalog,
  VisibleMeasure,
  VisibleMetric,
} from "../grants/visibleCatalog.js";
import {
  metricFormulaMeasures,
  metricFormulaProblem,
} from "../adapters/sql/metrics.js";
import {
  Planner,
  newQueryState,
  planSql,
  queryNameOf,
} from "../adapters/sql/plan.js";

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
  catalog: Omit<VisibleCatalog, "measures" | "metrics">
): Omit<VisibleCatalog, "measures" | "metrics"> => ({
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
  catalog: Omit<VisibleCatalog, "measures" | "metrics">,
  rows: readonly MeasureRow[],
  /** Told of a failure that is not a planner's refusal, such as a malformed stored formula. */
  onUnexpected: (err: unknown, measureId: string) => void = () => {}
): VisibleMeasure[] => {
  const candidates = rows
    .filter((r) => r.sourceId === catalog.source.id)
    .map(toVisible);
  if (candidates.length === 0) return [];
  const byName = new Map(candidates.map((m) => [m.name, m]));
  const probe = {
    ...withNothingMissing(catalog),
    measures: candidates,
    metrics: [],
  };
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

/**
 * The metrics of `rows` the caller of `catalog` may use: each formula is a
 * metric's (see `metricFormulaProblem`) and every measure it names is among
 * the caller's measures. One that is not is absent, exactly as if it did not
 * exist; a metric query naming it is refused as for a nonexistent name.
 */
export const visibleMetrics = (
  catalog: Pick<VisibleCatalog, "source" | "measures">,
  rows: readonly MetricRow[]
): VisibleMetric[] => {
  const usable = new Set(catalog.measures.map((m) => m.name));
  return rows
    .filter(
      (r) =>
        r.sourceId === catalog.source.id &&
        metricFormulaProblem(r.formula) === undefined &&
        metricFormulaMeasures(r.formula).every((name) => usable.has(name))
    )
    .map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      formula: r.formula,
    }));
};

/**
 * The type of `dateColumn` read from `home` through to-one relations, as a
 * metric query resolves a measure's date column. Throws the planner's
 * refusal (a `QueryError` or `MeasureError`) when it does not resolve.
 */
export const resolveDateColumn = (
  catalog: Omit<VisibleCatalog, "metrics">,
  home: VisibleCatalog["tables"][number],
  dateColumn: string,
  at: (string | number)[] = ["date_column"]
): string => {
  const planner = new Planner(
    { ...catalog, metrics: [] },
    new Date(),
    newQueryState()
  );
  planner.fromTable(home, ["table"]);
  return planner.resolveMeasureColumn(dateColumn, at).ref.type;
};

/**
 * A measure's date column as a caller who does not see every measure is
 * shown it: the stored path when it resolves to a date or timestamp column in
 * their catalogue, else null, exactly as for a measure with none (a metric
 * query treats it so). Missing columns count as present, as for visibility.
 * Every view of a measure for such a caller goes through this.
 */
export const visibleDateColumn = (
  catalog: Omit<VisibleCatalog, "metrics"> | null,
  measure: { tableId: string; dateColumn: string | null }
): string | null => {
  if (!catalog || measure.dateColumn === null) return null;
  const probe = { ...catalog, ...withNothingMissing(catalog) };
  const home = probe.tables.find((t) => t.id === measure.tableId);
  if (!home) return null;
  try {
    const type = resolveDateColumn(probe, home, measure.dateColumn);
    return type === "date" || type === "timestamp" ? measure.dateColumn : null;
  } catch (err) {
    if (err instanceof QueryError || err instanceof MeasureError) return null;
    throw err;
  }
};
