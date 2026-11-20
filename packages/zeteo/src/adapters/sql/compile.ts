import type { AnySelect, SqlDialect, ValueSubject } from "./dialect.js";
import { compileBusiness, compileBusinessDay } from "./businessDays.js";
import type { ZoneWindow } from "../../calendar/calendar.js";
import { QueryError } from "../../engine/errors.js";
import { METRIC_UNION as UNION } from "./types.js";
import { aggregatesRows } from "./aggregates.js";
import { plainNumber } from "./values.js";
import type {
  BucketUnit,
  ColumnRef,
  CompareOp,
  MetricPart,
  MetricPlan,
  TablePlan,
  FilterValue,
  HavingSubject,
  PlanValue,
  ResolvedExpr,
  ResolvedFilter,
  ResolvedJoin,
  ResolvedSelect,
  ScalarPlan,
  SqlPlan,
  TableName,
  WhereSubject,
} from "./types.js";
import {
  sql,
  type JoinBuilder,
  type RawBuilder,
  type Expression,
  type SqlBool,
} from "kysely";

export interface CompiledQuery {
  sql: string;
  parameters: unknown[];
}

// Identifiers come only from the plan and only through `sql.id`, which quotes
// each part and doubles any quote inside it; values are bound by the dialect,
// never written into the text. Select items are aliased c0, c1… by position:
// output names can be longer than an engine's alias limit, and the caller maps
// result columns back to `plan.columns` by index.

const COMPARE_SQL: Record<CompareOp, RawBuilder<unknown>> = {
  eq: sql`=`,
  ne: sql`<>`,
  gt: sql`>`,
  gte: sql`>=`,
  lt: sql`<`,
  lte: sql`<=`,
};
const AND = sql` and `;
const OR = sql` or `;

const table = (t: TableName) => sql.id(t.schemaName, t.name);
const column = (c: ColumnRef, dialect: SqlDialect) =>
  dialect.column(sql.id(c.alias, c.name), c.nativeType);

const ARITHMETIC = { add: sql` + `, sub: sql` - `, mul: sql` * ` } as const;

/**
 * Where an expression is compiled. A fixed measure's value is read per row
 * (`row`: in where, a row-level calc, inside an aggregate) as column `v` of a
 * one-row derived table joined on `1 = 1`, since SQL Server aggregates no
 * subquery and groups by none; elsewhere (group-level, outside any aggregate)
 * as a scalar subquery, which needs no grouping. `fixed` collects the derived
 * tables the current query level joins, by alias.
 */
export interface ExprContext {
  row: boolean;
  fixed: Map<string, ScalarPlan>;
  /**
   * The business-day subqueries of a dialect that cannot aggregate a
   * subquery (SQL Server), by alias: each is applied to every row, outer,
   * and read as its column `n`, so an aggregate (and GROUP BY) sees a column.
   */
  applied: Map<string, Expression<unknown>>;
}

const rowContext = (): ExprContext => ({
  row: true,
  fixed: new Map(),
  applied: new Map(),
});

/** Joins `joins` in order: inner or left, on their key equalities. */
const withJoins = (
  qb: AnySelect,
  joins: readonly ResolvedJoin[]
): AnySelect => {
  for (const join of joins) {
    const target = sql`${table(join.table)}`.as(join.alias);
    const on = (j: JoinBuilder<never, never>) =>
      j.on(
        sql<SqlBool>`${sql.join(
          join.on.map(
            ([parent, parentColumn, col]) =>
              sql`${sql.id(parent, parentColumn)} = ${sql.id(join.alias, col)}`
          ),
          AND
        )}`
      );
    qb =
      join.type === "inner"
        ? qb.innerJoin(target, on)
        : qb.leftJoin(target, on);
  }
  return qb;
};

/** Joins each one-row derived table of `fixed` on `1 = 1`, which keeps every row. */
const withFixed = (
  qb: AnySelect,
  fixed: ReadonlyMap<string, ScalarPlan>,
  dialect: SqlDialect
): AnySelect => {
  for (const plan of fixed.values()) {
    qb = qb.innerJoin(scalarQuery(plan, dialect).as(plan.alias), (j) =>
      j.on(sql<SqlBool>`1 = 1`)
    );
  }
  return qb;
};

/** Applies each business-day subquery of `applied` to every row, keeping every row. */
const withApplied = (
  qb: AnySelect,
  applied: ReadonlyMap<string, Expression<unknown>>
): AnySelect => {
  for (const [alias, lookup] of applied) {
    qb = qb.outerApply(sql`${lookup}`.as(alias));
  }
  return qb;
};

/**
 * A business-day subquery where it is used: as it is, or, per row on an
 * engine that aggregates no subquery, applied to every row and read as a
 * column. Operands compiled before it were applied first, so it may read them.
 */
const applied = (
  subquery: Expression<unknown>,
  dialect: SqlDialect,
  ctx: ExprContext
): Expression<unknown> => {
  if (!ctx.row || dialect.subqueryInAggregate) return subquery;
  const alias = `m${ctx.applied.size}`;
  ctx.applied.set(alias, subquery);
  return sql.id(alias, "n");
};

/**
 * A timestamp's date (the timestamp as a calculation reads it, its UTC
 * instant): in `zone` when given, converted once per row, else its UTC date.
 * Postgres converts natively, in place; SQL Server's conversion is a lookup
 * subquery, applied to the row where it is row-level (and read as a column,
 * which GROUP BY and an aggregate take), as a business-day subquery is.
 */
const localDate = (
  timestamp: Expression<unknown>,
  zone: ZoneWindow | undefined,
  dialect: SqlDialect,
  ctx: ExprContext
): Expression<unknown> => {
  if (!zone) return sql`cast(${timestamp} as date)`;
  const converted = dialect.zoneDate(timestamp, zone);
  return dialect.subqueryInAggregate
    ? converted
    : applied(sql`(select ${converted} as ${sql.id("n")})`, dialect, ctx);
};

/** A bucket of a date or timestamp column: its period's first day, a timestamp's in `zone`. */
const bucketOf = (
  unit: BucketUnit,
  c: ColumnRef,
  fiscalStartMonth: number,
  zone: ZoneWindow | undefined,
  dialect: SqlDialect,
  ctx: ExprContext
): Expression<unknown> => {
  const read = column(c, dialect);
  const date =
    c.type === "date"
      ? read
      : localDate(
          dialect.timestampUtc(read, c.nativeType),
          zone,
          dialect,
          // A bucket is row-level wherever it is: it is grouped by.
          { ...ctx, row: true }
        );
  return dialect.bucket(unit, date, fiscalStartMonth);
};

/** A fixed measure's own query: one row, its value as `v`. */
const scalarQuery = (plan: ScalarPlan, dialect: SqlDialect): AnySelect => {
  const ctx: ExprContext = { row: false, fixed: new Map(), applied: new Map() };
  const value = compileExpr(plan.expr, dialect, ctx);
  const qb = withJoins(
    dialect.kysely.selectFrom(sql`${table(plan.from)}`.as(plan.from.alias)),
    plan.joins
  ).select(sql`${value}`.as("v"));
  return withApplied(withFixed(qb, ctx.fixed, dialect), ctx.applied);
};
/** Whether an expression's value is a binary float on the engine (a float column, an average, arithmetic over either). */
const isApproximate = (expr: ResolvedExpr, dialect: SqlDialect): boolean => {
  switch (expr.kind) {
    case "column":
      return (
        expr.column.type === "number" && dialect.isFloat(expr.column.nativeType)
      );
    case "literal":
    case "dateAdd":
    case "dateDiff":
    case "datePart":
    case "businessDays":
    case "businessPeriod":
    case "addBusinessDays":
      return false;
    case "case":
      return [...expr.branches.map((b) => b.then), expr.otherwise].some(
        (e) => e !== undefined && isApproximate(e, dialect)
      );
    case "aggregate":
      if (expr.fn === "avg") return true;
      if (expr.fn === "count" || expr.fn === "countDistinct") return false;
      return expr.arg !== "*" && isApproximate(expr.arg, dialect);
    case "scalar":
      return isApproximate(expr.plan.expr, dialect);
    case "pivot":
      return isApproximate(expr.of, dialect);
    case "op":
      return (
        (expr.op === "add" ||
          expr.op === "sub" ||
          expr.op === "mul" ||
          expr.op === "abs" ||
          expr.op === "coalesce") &&
        expr.args.some((arg) => isApproximate(arg, dialect))
      );
  }
};

const typeOf = (expr: ResolvedExpr) =>
  expr.kind === "column" ? expr.column.type : expr.type;

/** A filter over catalogue columns: the column read as every part of the query reads it. */
const columnSubject = (dialect: SqlDialect) => (c: ColumnRef) => ({
  expression: column(c, dialect),
  type: c.type,
  nativeType: c.nativeType,
});

/** A planned calculation as SQL; literals are bound by the dialect. */
export const compileExpr = (
  expr: ResolvedExpr,
  dialect: SqlDialect,
  ctx: ExprContext = rowContext()
): Expression<unknown> => {
  const inner = (e: ResolvedExpr) => compileExpr(e, dialect, ctx);
  switch (expr.kind) {
    case "scalar":
      if (ctx.row) {
        ctx.fixed.set(expr.plan.alias, expr.plan);
        return sql.id(expr.plan.alias, "v");
      }
      // Kysely puts a subquery inside an expression in parentheses.
      return sql`${scalarQuery(expr.plan, dialect)}`;
    case "pivot":
      // Each period has one row per part, so max picks the part's value.
      return sql`max(${sql.id(UNION, `v${expr.index}`)})`;
    case "column": {
      const read = column(expr.column, dialect);
      if (expr.column.type === "text") {
        return dialect.text(read, expr.column.nativeType);
      }
      return expr.column.type === "timestamp"
        ? dialect.timestampUtc(read, expr.column.nativeType)
        : read;
    }
    case "literal":
      return dialect.literal(
        typeof expr.value === "number" ? plainNumber(expr.value) : expr.value,
        expr.type
      );
    case "dateAdd":
      return dialect.dateAdd(
        inner(expr.arg),
        expr.amount,
        expr.unit,
        expr.type
      );
    case "dateDiff":
      return dialect.dateDiff(
        expr.unit,
        inner(expr.start),
        inner(expr.end),
        expr.operand
      );
    case "datePart":
      return dialect.datePart(
        expr.part,
        expr.zone
          ? localDate(inner(expr.arg), expr.zone, dialect, ctx)
          : inner(expr.arg),
        expr.fiscalStartMonth
      );
    case "businessDays":
    case "businessPeriod":
      return applied(compileBusiness(expr, dialect, inner), dialect, ctx);
    case "addBusinessDays":
      return dialect.anchorPlus(
        applied(compileBusiness(expr, dialect, inner), dialect, ctx)
      );
    case "case": {
      const whens = expr.branches.map(
        (b) =>
          sql`when ${compileFilter(b.when, dialect, columnSubject(dialect), ctx)} then ${inner(b.then)}`
      );
      const otherwise = expr.otherwise
        ? sql` else ${inner(expr.otherwise)}`
        : sql``;
      return sql`case ${sql.join(whens, sql` `)}${otherwise} end`;
    }
    case "aggregate":
      if (expr.arg === "*") return dialect.aggregate(expr.fn, "*");
      return expr.arg.kind === "column"
        ? dialect.aggregate(
            expr.fn,
            column(expr.arg.column, dialect),
            expr.arg.column.nativeType
          )
        : dialect.aggregate(
            expr.fn,
            compileExpr(expr.arg, dialect, { ...ctx, row: true }),
            undefined,
            expr.arg
          );
    case "op": {
      const args = expr.args.map(inner);
      switch (expr.op) {
        case "add":
        case "sub":
        case "mul":
          return sql`(${sql.join(args, ARITHMETIC[expr.op])})`;
        case "div":
          return dialect.divide(args[0]!, args[1]!);
        case "round":
          return dialect.round(args[0]!, expr.places ?? 0);
        case "abs":
          return sql`abs(${args[0]!})`;
        case "lower":
          return sql`lower(${args[0]!})`;
        case "upper":
          return sql`upper(${args[0]!})`;
        case "coalesce":
          return sql`coalesce(${sql.join(args)})`;
        case "concat":
          return dialect.concat(
            expr.args.map((arg, i) =>
              typeOf(arg) === "number"
                ? dialect.numberToText(args[i]!, isApproximate(arg, dialect))
                : args[i]!
            )
          );
      }
      break;
    }
  }
  // A kind the switch does not know would compile to nothing, which binds as null.
  throw new Error(
    `cannot compile an expression of kind ${(expr as { kind: unknown }).kind}`
  );
};

/** Whether a select item is computed per group rather than per row. */
const perGroup = (item: ResolvedSelect) =>
  item.kind === "aggregate" || (item.kind === "calc" && item.level === "group");

const selectExpression = (
  item: ResolvedSelect,
  dialect: SqlDialect,
  fixed: Map<string, ScalarPlan>,
  applied: Map<string, Expression<unknown>>
): Expression<unknown> => {
  switch (item.kind) {
    case "column":
      return column(item.column, dialect);
    case "aggregate":
      return item.column === "*"
        ? dialect.aggregate(item.fn, "*")
        : dialect.aggregate(
            item.fn,
            column(item.column, dialect),
            item.column.nativeType
          );
    case "bucket":
      return bucketOf(
        item.unit,
        item.column,
        item.fiscalStartMonth,
        item.zone,
        dialect,
        { row: true, fixed, applied }
      );
    case "calc":
      return compileExpr(item.expr, dialect, {
        row: item.level === "row",
        fixed,
        applied,
      });
  }
};

const escapeLike = (text: string) => text.replace(/[\\%_]/g, "\\$&");

const compileFilter = <S>(
  filter: ResolvedFilter<S>,
  dialect: SqlDialect,
  subject: (s: S) => ValueSubject & { expression: Expression<unknown> },
  ctx: ExprContext
): Expression<SqlBool> => {
  /** A value bound for the subject, or a fixed measure's value. */
  const valueOf = (v: FilterValue, s: ValueSubject): Expression<unknown> =>
    typeof v === "object" && v !== null && "kind" in v
      ? compileExpr(v, dialect, ctx)
      : dialect.value(v, s);
  const go = (f: ResolvedFilter<S>): Expression<SqlBool> => {
    switch (f.kind) {
      case "and":
      case "or":
        return sql<SqlBool>`(${sql.join(
          f.filters.map(go),
          f.kind === "and" ? AND : OR
        )})`;
      case "not":
        return sql<SqlBool>`not (${go(f.filter)})`;
      case "compare": {
        const s = subject(f.subject);
        return sql<SqlBool>`${s.expression} ${COMPARE_SQL[f.op]} ${valueOf(f.value, s)}`;
      }
      case "between": {
        const s = subject(f.subject);
        return sql<SqlBool>`${s.expression} between ${valueOf(f.low, s)} and ${valueOf(f.high, s)}`;
      }
      case "in": {
        const s = subject(f.subject);
        const values = sql.join(
          f.values.map((v: PlanValue) => dialect.value(v, s))
        );
        return sql<SqlBool>`${s.expression} ${f.op === "in" ? sql`in` : sql`not in`} (${values})`;
      }
      case "match": {
        const escaped = escapeLike(f.value);
        const s = subject(f.subject);
        return dialect.like(
          s.expression,
          f.op === "contains" ? `%${escaped}%` : `${escaped}%`,
          s.nativeType
        );
      }
      case "isNull":
        return sql<SqlBool>`${subject(f.subject).expression} ${f.isNull ? sql`is null` : sql`is not null`}`;
      case "businessDay": {
        const s = subject(f.subject);
        // A timestamp column is read as its UTC instant, as a calculation reads it.
        const read =
          s.type === "timestamp" && s.nativeType !== undefined
            ? dialect.timestampUtc(s.expression, s.nativeType)
            : s.expression;
        const flag = applied(
          compileBusinessDay(
            read,
            s.type === "date" ? "date" : "timestamp",
            f.calendar,
            dialect
          ),
          dialect,
          ctx
        );
        return sql<SqlBool>`${flag} = ${sql.lit(f.is ? 1 : 0)}`;
      }
    }
  };
  return go(filter);
};

/**
 * Compiles a plan to SQL text and bound parameters without touching a
 * database. `fetch` is what the engine asks the database for (the requested
 * limit plus one, to see whether more rows exist); `plan.limit` and
 * `plan.offset` are not read. With `fetch.defaultOrder` false, a plan whose
 * order the planner supplied (`plan.defaultOrder`) is compiled with no order
 * at all, so the database need not sort before its first row. Throws `QueryError` `too_many_parameters` when the statement binds more
 * values than the dialect's engine takes.
 */
export const compileSql = (
  plan: SqlPlan,
  dialect: SqlDialect,
  fetch: { limit: number; offset: number; defaultOrder?: boolean }
): CompiledQuery =>
  finish(
    plan.kind === "metrics"
      ? compileMetrics(plan, dialect, fetch)
      : compileTable(plan, dialect, fetch),
    dialect
  );

/** The statement's text and parameters, refused when it binds more than the engine takes. */
const finish = (qb: AnySelect, dialect: SqlDialect): CompiledQuery => {
  const { sql: text, parameters } = qb.compile();
  if (parameters.length > dialect.maxParameters) {
    throw new QueryError(
      "too_many_parameters",
      `The query binds ${parameters.length} values; this source takes at most ${dialect.maxParameters} in one query, paging included`,
      []
    );
  }
  return { sql: text, parameters: [...parameters] };
};

/**
 * One part of a metric query: its measure's aggregate over its home table and
 * joins, its rows cut to the range on its date column, grouped by the bucket
 * of it as `period`. It selects its value as `v<k>` and null as every other
 * part's, so the union keeps each measure's own type in its own column.
 */
const partQuery = (
  plan: MetricPlan,
  part: MetricPart,
  k: number,
  dialect: SqlDialect
): AnySelect => {
  const ctx: ExprContext = { row: false, fixed: new Map(), applied: new Map() };
  let qb = withJoins(
    dialect.kysely.selectFrom(sql`${table(part.from)}`.as(part.from.alias)),
    part.joins
  );
  const items: unknown[] = [];
  const named: { expression: Expression<unknown>; alias: string }[] = [];
  let period: Expression<unknown> | undefined;
  if (plan.bucket) {
    period = bucketOf(
      plan.bucket.unit,
      part.date!,
      plan.bucket.fiscalStartMonth,
      plan.bucket.zone,
      dialect,
      ctx
    );
    named.push({ expression: period, alias: "period" });
  }
  const value = compileExpr(part.expr, dialect, ctx);
  // Each other part's column is a null of that part's type: Postgres types a
  // union's columns branch by branch, and two bare nulls would make one text.
  plan.parts.forEach((other, i) =>
    named.push({
      expression:
        i === k ? value : dialect.typedNull(isApproximate(other.expr, dialect)),
      alias: `v${i}`,
    })
  );
  for (const { expression, alias } of named) {
    items.push(sql`${expression}`.as(alias));
  }
  qb = qb.select(items as never);
  const bounds: ResolvedFilter<ColumnRef>[] = [];
  for (const op of ["gte", "lt"] as const) {
    const bound = part.range[op];
    if (bound !== undefined) {
      bounds.push({ kind: "compare", op, subject: part.date!, value: bound });
    }
  }
  if (bounds.length > 0) {
    qb = qb.where(
      compileFilter(
        bounds.length === 1 ? bounds[0]! : { kind: "and", filters: bounds },
        dialect,
        columnSubject(dialect),
        { ...ctx, row: true }
      )
    );
  }
  if (period) qb = dialect.groupBy(qb, [{ expression: period, index: 0 }]);
  return withApplied(withFixed(qb, ctx.fixed, dialect), ctx.applied);
};

/**
 * A metric query: its parts in a `UNION ALL` as `u`, grouped by `period`
 * (one group without a bucket), each select item computed over the parts'
 * values (`max(u.v<k>)`) and fixed measures' scalar subqueries. With no part
 * (fixed measures only) it reads no table and gives one row.
 */
const compileMetrics = (
  plan: MetricPlan,
  dialect: SqlDialect,
  fetch: { limit: number; offset: number; defaultOrder?: boolean }
): AnySelect => {
  const branches = plan.parts.map((part, k) =>
    partQuery(plan, part, k, dialect)
  );
  let qb: AnySelect =
    branches.length === 0
      ? (dialect.kysely.selectNoFrom([]) as unknown as AnySelect)
      : dialect.kysely.selectFrom(
          branches
            .slice(1)
            .reduce((union, branch) => union.unionAll(branch), branches[0]!)
            .as(UNION)
        );
  const ctx: ExprContext = { row: false, fixed: new Map(), applied: new Map() };
  const selected: Expression<unknown>[] = [];
  const outputs: ResolvedSelect[] = [];
  if (plan.bucket) {
    const ref: ColumnRef = {
      alias: UNION,
      name: "period",
      type: "date",
      nativeType: "date",
    };
    selected.push(sql.id(UNION, "period"));
    outputs.push({
      kind: "bucket",
      unit: plan.bucket.unit,
      fiscalStartMonth: plan.bucket.fiscalStartMonth,
      column: ref,
      output: "period",
      type: "date",
    });
  }
  for (const item of plan.select) {
    selected.push(compileExpr(item.expr, dialect, ctx));
    outputs.push({
      kind: "calc",
      expr: item.expr,
      level: "group",
      output: item.output,
      type: item.type,
    });
  }
  qb = qb.select(
    selected.map((e, i) =>
      sql`${dialect.output(outputs[i]!, e)}`.as(`c${i}`)
    ) as never
  );
  if (plan.bucket) {
    qb = dialect.groupBy(qb, [{ expression: selected[0]!, index: 0 }]);
  }
  const ordered = new Set<number>();
  const orderBy =
    fetch.defaultOrder === false && plan.defaultOrder
      ? []
      : plan.orderBy.filter(({ index }) => {
          if (ordered.has(index)) return false;
          ordered.add(index);
          return true;
        });
  for (const { index, direction } of orderBy) {
    qb = dialect.orderBy(
      qb,
      { expression: selected[index]!, alias: sql.id(`c${index}`) },
      direction
    );
  }
  qb = withApplied(withFixed(qb, ctx.fixed, dialect), ctx.applied);
  return dialect.page(qb, fetch.limit, fetch.offset, orderBy.length > 0);
};

/** A table query. */
const compileTable = (
  plan: TablePlan,
  dialect: SqlDialect,
  fetch: { limit: number; offset: number; defaultOrder?: boolean }
): AnySelect => {
  let qb: AnySelect = withJoins(
    dialect.kysely.selectFrom(sql`${table(plan.from)}`.as(plan.from.alias)),
    plan.joins
  );
  // The fixed measures read per row, joined once all is compiled.
  const fixed = new Map<string, ScalarPlan>();
  const applied = new Map<string, Expression<unknown>>();

  const selected = plan.select.map((item) =>
    selectExpression(item, dialect, fixed, applied)
  );
  qb = qb.select(
    selected.map((e, i) =>
      sql`${dialect.output(plan.select[i]!, e)}`.as(`c${i}`)
    )
  );
  if (plan.distinct) {
    qb = dialect.distinct(
      qb,
      selected.map((expression, index) => ({ expression, index })),
      plan.groupBy.length > 0 || plan.select.some(perGroup)
    );
  }

  if (plan.where) {
    qb = qb.where(
      compileFilter(
        plan.where,
        dialect,
        (s: WhereSubject) =>
          "index" in s
            ? { expression: selected[s.index]!, type: s.type }
            : columnSubject(dialect)(s),
        { row: true, fixed, applied }
      )
    );
  }

  if (plan.groupBy.length > 0) {
    qb = dialect.groupBy(
      qb,
      plan.groupBy.map((index) => ({ expression: selected[index]!, index }))
    );
  }

  if (
    plan.groupBy.length === 0 &&
    !plan.having &&
    plan.select.some(perGroup) &&
    !plan.select.some(aggregatesRows)
  ) {
    // Group-level items with no aggregate, only fixed measures: a HAVING makes
    // the query one group over all rows, so one row even over none, as an
    // aggregate would give. SQL Server's GROUP BY () gives no row over none.
    qb = qb.having(sql<SqlBool>`1 = 1`);
  } else if (plan.having) {
    qb = qb.having(
      compileFilter(
        plan.having,
        dialect,
        (h: HavingSubject) => ({
          expression: selected[h.index]!,
          type: h.type,
        }),
        { row: false, fixed, applied }
      )
    );
  }

  // SQL Server refuses an expression named twice in ORDER BY, which two select
  // items computing the same thing would give; a repeat changes no order.
  const ordered = new Set<string>();
  const orderBy = (
    fetch.defaultOrder === false && plan.defaultOrder ? [] : plan.orderBy
  ).flatMap((order) => {
    const { target } = order;
    const sorted =
      target.kind === "output"
        ? {
            expression: selected[target.index]!,
            alias: sql.id(`c${target.index}`),
          }
        : { expression: column(target.column, dialect) };
    const key = JSON.stringify(sorted.expression.toOperationNode(), (_, v) =>
      typeof v === "bigint" ? `${v}n` : v
    );
    if (ordered.has(key)) return [];
    ordered.add(key);
    return [{ sorted, direction: order.direction }];
  });
  for (const { sorted, direction } of orderBy) {
    qb = dialect.orderBy(qb, sorted, direction);
  }

  qb = withApplied(withFixed(qb, fixed, dialect), applied);
  return dialect.page(qb, fetch.limit, fetch.offset, orderBy.length > 0);
};
