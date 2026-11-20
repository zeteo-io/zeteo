import { QueryError, notFound, type QueryPath } from "../../engine/errors.js";
import type { OutputColumn, PlanContext, Reference } from "../types.js";
import { MeasureError } from "./measures.js";
import { METRIC_UNION } from "./types.js";
import type {
  VisibleCatalog,
  VisibleMeasure,
} from "../../grants/visibleCatalog.js";
import {
  compiledCalendar,
  dateOfDayNumber,
  dayNumber,
  localDate,
  zonedMidnight,
} from "../../calendar/calendar.js";
import {
  floorToMinute,
  resolveRelative,
  resolveRelativeDate,
} from "./relative.js";
import {
  measureFormulaSchema,
  type CalcExpr,
  type MetricQuery,
  type RangeBound,
} from "./language.js";
import type {
  ColumnRef,
  MetricPart,
  MetricPlan,
  MetricSelect,
  PlanValue,
  QueryableType,
  ResolvedExpr,
} from "./types.js";
import {
  Planner,
  VALUE_FORMS,
  coerce,
  fail,
  newQueryState,
  referenceKey,
  typeOf,
  type QueryState,
} from "./plan.js";

// A metric query asks for metrics and measures by name. Each distinct
// non-fixed measure it uses becomes a part: an aggregate subquery over its
// home table, cut to the range and grouped by the bucket of the measure's own
// date column. The compiler unions the parts and pivots them by period; each
// requested name is then a formula over the parts' values and the fixed
// measures' scalar subqueries. A measure named directly is the trivial metric.

/** Distinct non-fixed measures one metric query may combine. */
export const MAX_METRIC_MEASURES = 20;

/** The operations a metric's formula may use besides `measure` and numbers. */
const ARITHMETIC = new Set(["add", "sub", "mul", "div", "abs", "coalesce"]);
/** The calendar functions a metric's formula may use, each over literal dates only. */
const CALENDAR = new Set([
  "businessDays",
  "businessDaysBetween",
  "businessDaysIn",
  "businessDaysInMonth",
  "businessDaysElapsed",
  "businessDaysRemaining",
]);

/** A calendar function's date operands with their paths from `at`. */
const calendarDates = (
  key: string,
  operand: unknown,
  at: QueryPath
): Array<[unknown, QueryPath]> => {
  if (key === "businessDays" || key === "businessDaysBetween") {
    const [a, b] = operand as unknown[];
    return [
      [a, [...at, 0]],
      [b, [...at, 1]],
    ];
  }
  // businessDaysIn always, elapsed and remaining when given a unit: [unit, date].
  return Array.isArray(operand) ? [[operand[1], [...at, 1]]] : [[operand, at]];
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isDateLiteral = (v: unknown): boolean =>
  isObject(v) && ("date" in v || "timestamp" in v || "relative" in v);

const FORMULA_FORMS =
  "a metric's formula takes numbers, { measure }, add, sub, mul, div, abs, round, coalesce, calendar functions of literal dates and businessDaysInPeriod";

/** Where a metric's formula breaks its grammar, and how. */
export interface FormulaProblem {
  /** From the formula's root. */
  path: QueryPath;
  message: string;
}

/**
 * Whether `formula` is a metric's formula: an expression of the language
 * whose leaves are numbers and `{ measure: name }`, combined only by
 * arithmetic and constant calendar functions, using at least one measure. No
 * columns, `case`, aggregates, text or metrics. Undefined when it is one.
 */
export const metricFormulaProblem = (
  formula: unknown
): FormulaProblem | undefined => {
  const parsed = measureFormulaSchema.safeParse(formula);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    return { path: issue.path as QueryPath, message: issue.message };
  }
  const walk = (e: unknown, path: QueryPath): FormulaProblem | undefined => {
    if (typeof e === "number") return undefined;
    if (typeof e === "string") {
      return {
        path,
        message: `A metric reads no columns; ${FORMULA_FORMS}`,
      };
    }
    // A literal other than a number: text, or a date outside a calendar function.
    if (!isObject(e) || isDateLiteral(e) || "value" in e) {
      return { path, message: FORMULA_FORMS };
    }
    const [key, operand] = Object.entries(e)[0] ?? [];
    if (key === "measure") return undefined;
    if (key === undefined) return { path, message: FORMULA_FORMS };
    const at = [...path, key];
    if (key === "businessDaysInPeriod") return undefined;
    if (CALENDAR.has(key)) {
      const bad = calendarDates(key, operand, at).find(
        ([a]) => !isDateLiteral(a)
      );
      if (!bad) return undefined;
      return {
        path: bad[1],
        message:
          "In a metric, a calendar function takes a date, timestamp or relative date literal",
      };
    }
    if (key === "round") {
      const value = Array.isArray(operand) ? operand[0] : operand;
      return walk(value, Array.isArray(operand) ? [...at, 0] : at);
    }
    if (!ARITHMETIC.has(key)) return { path: at, message: FORMULA_FORMS };
    if (Array.isArray(operand)) {
      for (const [i, o] of operand.entries()) {
        const problem = walk(o, [...at, i]);
        if (problem) return problem;
      }
      return undefined;
    }
    return walk(operand, at);
  };
  const problem = walk(formula, []);
  if (problem) return problem;
  if (metricFormulaMeasures(formula as CalcExpr).length === 0) {
    return {
      path: [],
      message: "A metric's formula uses at least one measure",
    };
  }
  return undefined;
};

/** The measures a metric's formula names, each once, in order. */
export const metricFormulaMeasures = (formula: CalcExpr): string[] => {
  const names = new Set<string>();
  const walk = (e: unknown): void => {
    if (Array.isArray(e)) {
      e.forEach(walk);
      return;
    }
    if (!isObject(e) || isDateLiteral(e) || "value" in e) return;
    const [key, operand] = Object.entries(e)[0] ?? [];
    if (key === "measure" && typeof operand === "string") names.add(operand);
    else walk(operand);
  };
  walk(formula);
  return [...names];
};

/** A range bound as a value for a date column of `type`, read in the calendar's zone. */
const boundFor = (
  bound: RangeBound,
  type: "date" | "timestamp",
  now: Date,
  catalog: VisibleCatalog
): PlanValue => {
  const { calendar } = catalog;
  if ("relative" in bound) {
    return type === "date"
      ? resolveRelativeDate(bound, now, calendar)
      : resolveRelative(bound, now, calendar).toISOString();
  }
  if ("date" in bound) {
    return type === "date"
      ? bound.date
      : zonedMidnight(bound.date, calendar.timeZone).toISOString();
  }
  return type === "timestamp"
    ? bound.timestamp
    : localDate(new Date(bound.timestamp), calendar.timeZone);
};

/** The range's literal bounds checked once, whatever measures read them. */
const checkRange = (range: MetricQuery["range"]): void => {
  for (const key of ["gte", "lt"] as const) {
    const bound = range?.[key];
    if (bound === undefined || "relative" in bound) continue;
    const type = "date" in bound ? "date" : "timestamp";
    const given = "date" in bound ? bound.date : bound.timestamp;
    if (coerce(given, type) === undefined) {
      throw fail("invalid_value", `A ${type} bound is ${VALUE_FORMS[type]}`, [
        "range",
        key,
        type,
      ]);
    }
  }
};

/** Codes for a date column the caller cannot use: as if the measure had none. */
const UNUSABLE_DATE = new Set([
  "not_found_or_not_accessible",
  "measure_reads_to_many",
  "column_not_queryable",
  "join_parent_missing",
]);

class MetricPlanner {
  readonly state: QueryState = newQueryState();
  /** Fixed measures and calendar functions, planned from no table. */
  private readonly outer: Planner;
  private readonly measures: Map<string, VisibleMeasure>;
  readonly parts: MetricPart[] = [];
  /** Per part, the columns its value reads. */
  readonly partReads: Map<string, Reference>[] = [];
  private readonly partIndex = new Map<string, number>();
  /** The date columns the parts read, each once. */
  readonly dates = new Map<string, Reference>();
  private readonly needsDate: boolean;

  constructor(
    private readonly catalog: VisibleCatalog,
    private readonly now: Date,
    private readonly query: MetricQuery
  ) {
    this.outer = new Planner(catalog, now, this.state);
    this.measures = new Map(catalog.measures.map((m) => [m.name, m]));
    this.needsDate = query.bucket !== undefined || query.range !== undefined;
  }

  /** The part of non-fixed measure `measure`, planned once per query. */
  private partOf(measure: VisibleMeasure, at: QueryPath): number {
    const known = this.partIndex.get(measure.name);
    if (known !== undefined) return known;
    if (this.parts.length >= MAX_METRIC_MEASURES) {
      throw fail(
        "too_complex",
        `A metric query combines at most ${MAX_METRIC_MEASURES} measures that are not fixed`,
        at
      );
    }
    const home = this.catalog.tables.find((t) => t.id === measure.tableId);
    if (!home) throw notFound("measure", measure.name, at, []);
    const planner = new Planner(this.catalog, this.now, this.state);
    planner.fromTable(home, at);
    const reads = new Map<string, Reference>();
    const calc = planner.resolveExpr({ measure: measure.name }, at, reads);
    const type = typeOf(calc.resolved);
    if (type !== "number") {
      throw fail(
        "invalid_operator",
        `A metric query combines numbers; measure "${measure.name}" is ${type}`,
        at
      );
    }
    let date: ColumnRef | undefined;
    const range: MetricPart["range"] = {};
    if (this.needsDate) {
      date = this.dateOf(planner, measure, at);
      for (const key of ["gte", "lt"] as const) {
        const bound = this.query.range?.[key];
        if (bound !== undefined) {
          range[key] = boundFor(
            bound,
            date.type as "date" | "timestamp",
            this.now,
            this.catalog
          );
        }
      }
    }
    const index = this.parts.length;
    this.parts.push({
      from: { alias: "t0", schemaName: home.schemaName, name: home.name },
      joins: planner.joins,
      expr: calc.resolved,
      date,
      range,
    });
    this.partReads.push(reads);
    this.partIndex.set(measure.name, index);
    return index;
  }

  /**
   * The measure's date column, read through its to-one relations. One the
   * caller cannot use, or one that is not a date or timestamp, is as if the
   * measure had none: `measure_has_no_date`, telling nothing of the column.
   */
  private dateOf(
    planner: Planner,
    measure: VisibleMeasure,
    at: QueryPath
  ): ColumnRef {
    const noDate = () =>
      fail(
        "measure_has_no_date",
        `Measure "${measure.name}" has no date column, which bucket and range need`,
        at
      );
    if (measure.dateColumn === null) throw noDate();
    let ref: ColumnRef;
    try {
      const resolved = planner.resolveMeasureColumn(measure.dateColumn, at);
      ref = resolved.ref;
      this.dates.set(referenceKey(resolved.reference), resolved.reference);
    } catch (err) {
      if (err instanceof QueryError && UNUSABLE_DATE.has(err.code)) {
        throw noDate();
      }
      if (err instanceof QueryError) {
        throw new QueryError(
          err.code,
          `Measure "${measure.name}": ${err.message}`,
          at
        );
      }
      throw err;
    }
    if (ref.type !== "date" && ref.type !== "timestamp") throw noDate();
    return ref;
  }

  /**
   * `businessDaysInPeriod`: the business days of each period of the bucket,
   * read from the union's `period` (the bucket's first day, in UTC as buckets
   * are); without a bucket, those of the range, from `gte`'s date up to, not
   * including, `lt`'s, each bound's date in the calendar's zone.
   */
  private businessDaysInPeriod(at: QueryPath): ResolvedExpr {
    const { calendar } = this.catalog;
    const unit = this.query.bucket;
    if (unit !== undefined) {
      return {
        kind: "businessPeriod",
        fn: "in",
        unit,
        fiscalStartMonth: unit.startsWith("fiscal_")
          ? calendar.fiscalYearStartMonth
          : 1,
        date: {
          // A timestamp period is read as its date: the bucket starts at UTC midnight.
          expr: {
            kind: "column",
            column: {
              alias: METRIC_UNION,
              name: "period",
              type: "date",
              nativeType: "date",
            },
          },
          type: "date",
        },
        calendar: compiledCalendar(calendar, this.now),
        type: "number",
      };
    }
    const { gte, lt } = this.query.range ?? {};
    if (gte === undefined || lt === undefined) {
      throw fail(
        "invalid_operator",
        "businessDaysInPeriod needs the query's bucket, or a range with both gte and lt",
        at
      );
    }
    const dateOf = (bound: RangeBound): string =>
      "date" in bound
        ? bound.date
        : "timestamp" in bound
          ? localDate(new Date(bound.timestamp), calendar.timeZone)
          : resolveRelativeDate(bound, this.now, calendar);
    const last = dateOfDayNumber(dayNumber(dateOf(lt)) - 1);
    return this.outer.resolveExpr(
      { businessDays: [{ date: dateOf(gte) }, { date: last }] },
      at,
      new Map()
    ).resolved;
  }

  /**
   * A requested name's formula: `{ measure }` is the part's value per period,
   * or a fixed measure's scalar subquery; numbers, arithmetic and calendar
   * constants as in a table query's calc. `formula` is a metric's own (its
   * grammar is checked when the catalogue is built) or `{ measure: name }`.
   */
  resolveFormula(
    formula: CalcExpr,
    at: QueryPath,
    reads: Map<string, Reference>
  ): ResolvedExpr {
    if (typeof formula === "number") {
      return { kind: "literal", value: formula, type: "number" };
    }
    if (!isObject(formula)) throw fail("invalid_operator", FORMULA_FORMS, at);
    const [key, operand] = Object.entries(formula)[0] as [string, unknown];
    if (key === "measure") {
      const name = operand as string;
      const measure = this.measures.get(name);
      if (!measure) {
        throw notFound(
          "measure",
          name,
          at,
          this.catalog.measures.map((m) => m.name)
        );
      }
      if (measure.fixed) {
        return this.outer.resolveFixedMeasure(measure, at, reads).resolved;
      }
      const index = this.partOf(measure, at);
      for (const [k, ref] of this.partReads[index]!) reads.set(k, ref);
      const of = this.parts[index]!.expr;
      return { kind: "pivot", index, of, type: typeOf(of) };
    }
    if (CALENDAR.has(key)) {
      return this.outer.resolveExpr(formula, at, reads).resolved;
    }
    if (key === "businessDaysInPeriod") return this.businessDaysInPeriod(at);
    if (!ARITHMETIC.has(key) && key !== "round") {
      throw fail("invalid_operator", FORMULA_FORMS, at);
    }
    const op = key as "add" | "sub" | "mul" | "div" | "abs" | "round";
    let places: number | undefined;
    let operands: CalcExpr[];
    if (op === "round") {
      if (Array.isArray(operand)) {
        operands = [operand[0] as CalcExpr];
        places = operand[1] as number;
      } else {
        operands = [operand as CalcExpr];
        places = 0;
      }
    } else {
      operands = Array.isArray(operand)
        ? (operand as CalcExpr[])
        : [operand as CalcExpr];
    }
    const args = operands.map((o) => this.resolveFormula(o, at, reads));
    const types = args.map(typeOf);
    let type: QueryableType = "number";
    if (key === "coalesce") {
      type = types[0]!;
      if (types.some((t) => t !== type)) {
        throw fail(
          "invalid_operator",
          "coalesce takes operands of one type",
          at
        );
      }
    } else if (types.some((t) => t !== "number")) {
      throw fail(
        "invalid_operator",
        `${key} needs numbers; an operand is ${types.find((t) => t !== "number")}`,
        at
      );
    }
    return {
      kind: "op",
      op: key as "add",
      args,
      ...(places === undefined ? {} : { places }),
      type,
    };
  }
}

/** Resolves a metric query against `catalog`, the caller's view of the source. */
export const planMetrics = (
  query: MetricQuery,
  catalog: VisibleCatalog,
  ctx?: PlanContext
): MetricPlan => {
  const now = ctx?.now ?? floorToMinute(new Date());
  checkRange(query.range);
  const planner = new MetricPlanner(catalog, now, query);
  const metrics = new Map(catalog.metrics.map((m) => [m.name, m]));
  const measureNames = new Set(catalog.measures.map((m) => m.name));

  const select: MetricSelect[] = [];
  const valueColumns: OutputColumn[] = [];
  query.metrics.forEach((name, i) => {
    const at = ["metrics", i];
    // Names are unique per source across measures and metrics.
    const metric = measureNames.has(name) ? undefined : metrics.get(name);
    if (!measureNames.has(name) && !metric) {
      throw notFound("metric", name, at, [...metrics.keys(), ...measureNames]);
    }
    const reads = new Map<string, Reference>();
    let expr: ResolvedExpr;
    try {
      expr = planner.resolveFormula(
        metric ? metric.formula : { measure: name },
        at,
        reads
      );
    } catch (err) {
      // Inside a metric's formula, which the caller did not write, every
      // refusal is reported at the name, naming the metric.
      if (
        metric &&
        (err instanceof QueryError || err instanceof MeasureError)
      ) {
        throw new QueryError(err.code, `Metric "${name}": ${err.message}`, at);
      }
      throw err;
    }
    if (query.bucket !== undefined && name === "period") {
      throw fail(
        "duplicate_output_name",
        'A bucketed metric query names its first column "period"; it cannot also ask for one named so',
        at
      );
    }
    select.push({ output: name, expr, type: typeOf(expr) });
    valueColumns.push({
      name,
      type: typeOf(expr),
      references: [...reads.values()],
    });
  });

  const { parts } = planner;
  let bucket: MetricPlan["bucket"];
  const columns: OutputColumn[] = [];
  if (query.bucket !== undefined) {
    if (parts.length === 0) {
      throw fail(
        "invalid_operator",
        "A bucket needs a measure that is not fixed: a fixed measure has no periods",
        ["bucket"]
      );
    }
    const type = parts.some((p) => p.date!.type === "timestamp")
      ? "timestamp"
      : "date";
    bucket = {
      unit: query.bucket,
      // Read only by a fiscal unit: a calendar change leaves other plans alone.
      fiscalStartMonth: query.bucket.startsWith("fiscal_")
        ? catalog.calendar.fiscalYearStartMonth
        : 1,
      type,
    };
    columns.push({
      name: "period",
      type,
      references: [...planner.dates.values()],
    });
  }
  columns.push(...valueColumns);

  const outputIndex = (key: string): number =>
    columns.findIndex((c) => c.name === key);
  const orderBy: MetricPlan["orderBy"] = query.orderBy
    ? query.orderBy.map((entry, j) => {
        const [key, direction] = Object.entries(entry)[0]!;
        const index = outputIndex(key);
        if (index < 0) {
          throw fail(
            "invalid_order",
            `"${key}" is not a result column; order by ${bucket ? "period or " : ""}a name the query asks for`,
            ["orderBy", j, key]
          );
        }
        return { index, direction };
      })
    : bucket
      ? [{ index: 0, direction: "asc" }]
      : [];

  return {
    kind: "metrics",
    parts,
    bucket,
    select,
    orderBy,
    defaultOrder: (query.orderBy?.length ?? 0) === 0,
    references: [...planner.state.references.values()],
    columns,
    warnings: [],
    limit: query.limit,
    offset: query.offset ?? 0,
  };
};
