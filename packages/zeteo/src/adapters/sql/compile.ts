import type { AnySelect, SqlDialect, ValueSubject } from "./dialect.js";
import { QueryError } from "../../engine/errors.js";
import { plainNumber } from "./values.js";
import type {
  ColumnRef,
  CompareOp,
  HavingSubject,
  PlanValue,
  ResolvedExpr,
  ResolvedFilter,
  ResolvedSelect,
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

/** Whether an expression's value is a binary float on the engine (a float column, an average, arithmetic over either). */
const isApproximate = (expr: ResolvedExpr, dialect: SqlDialect): boolean => {
  switch (expr.kind) {
    case "column":
      return (
        expr.column.type === "number" && dialect.isFloat(expr.column.nativeType)
      );
    case "literal":
      return false;
    case "case":
      return [...expr.branches.map((b) => b.then), expr.otherwise].some(
        (e) => e !== undefined && isApproximate(e, dialect)
      );
    case "aggregate":
      if (expr.fn === "avg") return true;
      if (expr.fn === "count" || expr.fn === "countDistinct") return false;
      return expr.arg !== "*" && isApproximate(expr.arg, dialect);
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
  dialect: SqlDialect
): Expression<unknown> => {
  switch (expr.kind) {
    case "column": {
      const read = column(expr.column, dialect);
      return expr.column.type === "text"
        ? dialect.text(read, expr.column.nativeType)
        : read;
    }
    case "literal":
      return dialect.literal(
        typeof expr.value === "number" ? plainNumber(expr.value) : expr.value,
        expr.type
      );
    case "case": {
      const whens = expr.branches.map(
        (b) =>
          sql`when ${compileFilter(b.when, dialect, columnSubject(dialect))} then ${compileExpr(b.then, dialect)}`
      );
      const otherwise = expr.otherwise
        ? sql` else ${compileExpr(expr.otherwise, dialect)}`
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
            compileExpr(expr.arg, dialect),
            undefined,
            expr.arg
          );
    case "op": {
      const args = expr.args.map((arg) => compileExpr(arg, dialect));
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
    }
  }
};

/** Whether a select item is computed per group rather than per row. */
const perGroup = (item: ResolvedSelect) =>
  item.kind === "aggregate" || (item.kind === "calc" && item.level === "group");

const selectExpression = (
  item: ResolvedSelect,
  dialect: SqlDialect
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
      return dialect.bucket(
        item.unit,
        column(item.column, dialect),
        item.column.type === "date" ? "date" : "timestamp",
        item.column.nativeType
      );
    case "calc":
      return compileExpr(item.expr, dialect);
  }
};

const escapeLike = (text: string) => text.replace(/[\\%_]/g, "\\$&");

const compileFilter = <S>(
  filter: ResolvedFilter<S>,
  dialect: SqlDialect,
  subject: (s: S) => ValueSubject & { expression: Expression<unknown> }
): Expression<SqlBool> => {
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
        return sql<SqlBool>`${s.expression} ${COMPARE_SQL[f.op]} ${dialect.value(f.value, s)}`;
      }
      case "between": {
        const s = subject(f.subject);
        return sql<SqlBool>`${s.expression} between ${dialect.value(f.low, s)} and ${dialect.value(f.high, s)}`;
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
): CompiledQuery => {
  let qb: AnySelect = dialect.kysely.selectFrom(
    sql`${table(plan.from)}`.as(plan.from.alias)
  );
  for (const join of plan.joins) {
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

  const selected = plan.select.map((item) => selectExpression(item, dialect));
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
      compileFilter(plan.where, dialect, (s: WhereSubject) =>
        "index" in s
          ? { expression: selected[s.index]!, type: s.type }
          : columnSubject(dialect)(s)
      )
    );
  }

  if (plan.groupBy.length > 0) {
    qb = dialect.groupBy(
      qb,
      plan.groupBy.map((index) => ({ expression: selected[index]!, index }))
    );
  }

  if (plan.having) {
    qb = qb.having(
      compileFilter(plan.having, dialect, (h: HavingSubject) => ({
        expression: selected[h.index]!,
        type: h.type,
      }))
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

  qb = dialect.page(qb, fetch.limit, fetch.offset, orderBy.length > 0);
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
