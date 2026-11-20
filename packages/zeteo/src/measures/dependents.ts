import type { CalcExpr, Filter } from "../adapters/sql/language.js";
import { planSql, queryNameOf } from "../adapters/sql/plan.js";
import { MeasureError } from "../adapters/sql/measures.js";
import { QueryError } from "../engine/errors.js";
import { prisma } from "../utils/db/prisma.js";
import type {
  MeasureRow,
  MetricRow,
  VisibleCatalog,
} from "../grants/visibleCatalog.js";
import {
  metricFormulaMeasures,
  planMetrics,
  usesPeriodBusinessDays,
} from "../adapters/sql/metrics.js";

// What a change to one measure does to the others: which measures use it,
// directly or through others, and whether every measure of a source still
// plans against the source's whole catalogue.

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The names of the measures `formula` (or a filter) uses directly: in the
 * expression, and as fixed measures compared with in a `case`'s conditions.
 */
export const measuresIn = (formula: CalcExpr | Filter): Set<string> => {
  const names = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const v of value) walk(v);
      return;
    }
    if (!isObject(value)) return;
    if (typeof value.measure === "string") {
      names.add(value.measure);
      return;
    }
    for (const inner of Object.values(value)) walk(inner);
  };
  walk(formula);
  return names;
};

/** The measures of `rows` that use `name`, directly or through others, by name. */
export const dependentsOf = (
  name: string,
  rows: readonly MeasureRow[]
): MeasureRow[] => {
  const found = new Map<string, MeasureRow>();
  const pending = [name];
  while (pending.length > 0) {
    const used = pending.pop()!;
    for (const row of rows) {
      if (row.name === name || found.has(row.name)) continue;
      if (
        measuresIn(row.formula).has(used) ||
        (row.where !== null && measuresIn(row.where).has(used))
      ) {
        found.set(row.name, row);
        pending.push(row.name);
      }
    }
  }
  return [...found.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
};

/** A measure that does not plan against the source's whole catalogue, and why. */
export interface MeasureProblem {
  name: string;
  code: string;
  message: string;
}

/**
 * The measures of `rows` (or those `only` names) that do not plan alone from
 * their home table against `fullCatalog`, every column granted: the
 * structural check of home table, result type, loops, nesting and node
 * limits, joins and missing columns. A measure's dependency failing fails it too.
 */
export const checkMeasureSet = (
  rows: readonly MeasureRow[],
  fullCatalog: Omit<VisibleCatalog, "measures">,
  only?: ReadonlySet<string>
): MeasureProblem[] => {
  const catalog: VisibleCatalog = {
    ...fullCatalog,
    measures: rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      tableId: r.tableId,
      formula: r.formula,
      where: r.where,
      fixed: r.fixed,
      dateColumn: r.dateColumn,
    })),
  };
  const now = new Date();
  const problems: MeasureProblem[] = [];
  for (const row of rows) {
    if (only && !only.has(row.name)) continue;
    const home = catalog.tables.find((t) => t.id === row.tableId);
    if (!home) {
      problems.push({
        name: row.name,
        code: "missing_in_source",
        message: "Its table is not in the source's catalogue",
      });
      continue;
    }
    try {
      planSql(
        {
          source: catalog.source.slug,
          from: queryNameOf(catalog.tables, home),
          select: [{ measure: row.name }],
        },
        catalog,
        { now }
      );
    } catch (err) {
      if (err instanceof QueryError || err instanceof MeasureError) {
        problems.push({ name: row.name, code: err.code, message: err.message });
      } else {
        problems.push({
          name: row.name,
          code: "invalid_measure",
          message: "The stored measure could not be read",
        });
      }
    }
  }
  return problems;
};

/** The metrics of `metrics` whose formula names any of `names`, by name. */
export const metricsUsing = (
  names: ReadonlySet<string>,
  metrics: readonly MetricRow[]
): MetricRow[] =>
  metrics
    .filter((m) => metricFormulaMeasures(m.formula).some((n) => names.has(n)))
    .sort((a, b) => (a.name < b.name ? -1 : 1));

/** How a metric plans against the source's whole catalogue: alone, and bucketed by month. */
export interface MetricCheck {
  name: string;
  /** Why it does not plan alone; null when it does. */
  plain: { code: string; message: string } | null;
  /** Why it does not plan bucketed by month (so its measures' date columns); null when it does. */
  bucketed: { code: string; message: string } | null;
}

/**
 * The metrics of `metrics` (or those `only` names) planned against
 * `fullCatalog` with `measures`, every column granted: alone, and bucketed by
 * month, which needs every non-fixed measure it uses to have a usable date
 * column. A metric that used to plan in either way and would not now is one
 * a change breaks.
 */
export const checkMetricSet = (
  metrics: readonly MetricRow[],
  measures: readonly MeasureRow[],
  fullCatalog: Omit<VisibleCatalog, "measures" | "metrics">,
  only?: ReadonlySet<string>
): MetricCheck[] => {
  const catalog: VisibleCatalog = {
    ...fullCatalog,
    measures: measures.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      tableId: r.tableId,
      formula: r.formula,
      where: r.where,
      fixed: r.fixed,
      dateColumn: r.dateColumn,
    })),
    metrics: metrics.map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
      formula: m.formula,
    })),
  };
  const now = new Date();
  const attempt = (name: string, bucketed: boolean) => {
    try {
      planMetrics(
        {
          source: catalog.source.slug,
          metrics: [name],
          ...(bucketed && { bucket: "month" as const }),
        },
        catalog,
        { now }
      );
      return null;
    } catch (err) {
      if (err instanceof QueryError || err instanceof MeasureError) {
        return { code: err.code, message: err.message };
      }
      return {
        code: "invalid_metric",
        message: "The stored metric could not be read",
      };
    }
  };
  return metrics
    .filter((m) => !only || only.has(m.name))
    .map((m) => {
      const bucketed = attempt(m.name, true);
      return {
        name: m.name,
        // One that needs a bucket (businessDaysInPeriod) is only ever run with one.
        plain: usesPeriodBusinessDays(m.formula)
          ? bucketed
          : attempt(m.name, false),
        bucketed,
      };
    });
};

/** The saved queries' JSON conditions for a use of a measure or a metric named `n`. */
const IN_METRICS = `$.metrics[*] ? (@ == $n)`;
const AS_MEASURE = `$.** ? (@.measure == $n)`;

/**
 * The saved queries of the source whose JSON uses the measure or metric
 * `name` (a measure anywhere as `{ measure }` or by name in a metric query's
 * `metrics`; a metric in `metrics`), and the dashboard panels showing one of
 * them, directly or through a saved panel.
 */
export const usedBy = async (
  sourceId: string,
  name: string,
  kind: "measure" | "metric" = "measure"
): Promise<{ saved_queries: number; panels: number }> => {
  const asMeasure = kind === "measure";
  const [row] = await prisma.$queryRaw<
    { saved_queries: number; panels: number }[]
  >`
    WITH used AS (
      SELECT q."id" FROM "zeteo"."saved_queries" q
       WHERE q."source_id" = ${sourceId}::uuid
         AND (
           jsonb_path_exists(
             q."query",
             ${IN_METRICS}::jsonpath,
             jsonb_build_object('n', ${name}::text)
           )
           OR (${asMeasure} AND jsonb_path_exists(
             q."query",
             ${AS_MEASURE}::jsonpath,
             jsonb_build_object('n', ${name}::text)
           ))
         )
    )
    SELECT
      (SELECT count(*)::int FROM used) AS "saved_queries",
      (SELECT count(*)::int FROM "zeteo"."dashboard_panels" p
        WHERE p."saved_query_id" IN (SELECT "id" FROM used)
           OR p."saved_panel_id" IN (
             SELECT sp."id" FROM "zeteo"."saved_panels" sp
              WHERE sp."saved_query_id" IN (SELECT "id" FROM used)
           )) AS "panels"`;
  return row ?? { saved_queries: 0, panels: 0 };
};
