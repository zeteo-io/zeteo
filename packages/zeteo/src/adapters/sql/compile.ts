import type { AnySelect, SqlDialect, ValueSubject } from "./dialect.js";
import type {
  ColumnRef,
  CompareOp,
  HavingSubject,
  PlanValue,
  ResolvedFilter,
  ResolvedSelect,
  SqlPlan,
  TableName,
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
const column = (c: ColumnRef) => sql.id(c.alias, c.name);

const selectExpression = (
  item: ResolvedSelect,
  dialect: SqlDialect
): Expression<unknown> => {
  switch (item.kind) {
    case "column":
      return column(item.column);
    case "aggregate":
      return item.column === "*"
        ? dialect.aggregate(item.fn, "*")
        : dialect.aggregate(
            item.fn,
            column(item.column),
            item.column.nativeType
          );
    case "bucket":
      return dialect.bucket(
        item.unit,
        column(item.column),
        item.column.type === "date" ? "date" : "timestamp",
        item.column.nativeType
      );
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
        return dialect.like(
          subject(f.subject).expression,
          f.op === "contains" ? `%${escaped}%` : `${escaped}%`
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
 * `plan.offset` are not read.
 */
export const compileSql = (
  plan: SqlPlan,
  dialect: SqlDialect,
  fetch: { limit: number; offset: number }
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
      plan.groupBy.length > 0 ||
        plan.select.some((item) => item.kind === "aggregate")
    );
  }

  if (plan.where) {
    qb = qb.where(
      compileFilter(plan.where, dialect, (c) => ({
        expression: column(c),
        type: c.type,
        nativeType: c.nativeType,
      }))
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

  for (const order of plan.orderBy) {
    const { target } = order;
    qb = dialect.orderBy(
      qb,
      target.kind === "output"
        ? {
            expression: selected[target.index]!,
            alias: sql.id(`c${target.index}`),
          }
        : { expression: column(target.column) },
      order.direction
    );
  }

  qb = dialect.page(qb, fetch.limit, fetch.offset, plan.orderBy.length > 0);
  const { sql: text, parameters } = qb.compile();
  return { sql: text, parameters: [...parameters] };
};
