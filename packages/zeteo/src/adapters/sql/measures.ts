import { isLiteralObject, type CalcExpr, type Filter } from "./language.js";
import type { VisibleMeasure } from "../../grants/visibleCatalog.js";

// A measure is a named group-level expression on one home table. The planner
// meets `{ measure: name }` and resolves the measure's formula in its place:
// measures it uses are substituted in turn, and each measure's `where` is
// pushed into every aggregate beneath it as a `case`, so the expansion is an
// ordinary expression that grants, types and both dialects take as they are.

/** Measures a measure may reach through others: one using another is one level. */
export const MAX_MEASURE_NESTING = 8;
/** Operations and aggregates the measures of one query expand to. */
export const MAX_EXPANDED_NODES = 500;

export interface Expansion {
  expr: CalcExpr;
  /** Every relation path the expansion reads, parents before children. */
  relationPaths: string[];
  /** Every measure it uses, besides itself, at any depth. */
  uses: string[];
  /** Its operations and aggregates, counted as the language counts them. */
  nodes: number;
}

export type MeasureErrorCode =
  | "measure_cycle"
  | "measure_too_deep"
  | "measure_not_aggregate"
  | "not_found_or_not_accessible"
  | "invalid_operator"
  | "too_complex";

/** A measure that cannot be expanded; the planner reports it at the measure's path. */
export class MeasureError extends Error {
  constructor(
    public code: MeasureErrorCode,
    message: string
  ) {
    super(message);
    this.name = "MeasureError";
  }
}

const AGGREGATES = new Set([
  "sum",
  "avg",
  "min",
  "max",
  "count",
  "countDistinct",
]);
/** Per operation whose operand is an array, the indexes that hold expressions. */
const EXPRESSION_INDEXES: Record<string, readonly number[]> = {
  dateAdd: [0],
  dateDiff: [1, 2],
  datePart: [1],
  round: [0],
};
const LOGICAL = new Set(["and", "or", "not"]);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Every column path a filter names, in order. */
const filterPaths = (filter: Filter, out: (path: string) => void): void => {
  for (const [key, value] of Object.entries(filter)) {
    if (!LOGICAL.has(key)) out(key);
    else if (Array.isArray(value)) {
      for (const f of value as Filter[]) filterPaths(f, out);
    } else filterPaths(value as Filter, out);
  }
};

/** Every column path an expression reads, in order, `if` keys included. */
const exprPaths = (expr: CalcExpr, out: (path: string) => void): void => {
  if (typeof expr === "string") {
    if (expr !== "*") out(expr);
    return;
  }
  if (!isObject(expr) || isLiteralObject(expr)) return;
  const [key, operand] = Object.entries(expr)[0] ?? [];
  if (key === undefined || key === "measure") return;
  if (key === "case") {
    const { when, else: otherwise } = operand as {
      when: { if: Filter; then: CalcExpr }[];
      else?: CalcExpr;
    };
    for (const branch of when) {
      filterPaths(branch.if, out);
      exprPaths(branch.then, out);
    }
    if (otherwise !== undefined) exprPaths(otherwise, out);
    return;
  }
  if (Array.isArray(operand)) {
    const indexes = EXPRESSION_INDEXES[key];
    operand.forEach((e, i) => {
      if (!indexes || indexes.includes(i)) exprPaths(e as CalcExpr, out);
    });
    return;
  }
  exprPaths(operand as CalcExpr, out);
};

/** The relation paths `expr` reads, each after its parent: `a.b.c` reads `a`, then `a.b`. */
export const relationPathsOf = (expr: CalcExpr): string[] => {
  const paths = new Set<string>();
  exprPaths(expr, (path) => {
    const segments = path.split(".");
    for (let i = 1; i < segments.length; i++) {
      paths.add(segments.slice(0, i).join("."));
    }
  });
  return [...paths];
};

const conditionOf = (wheres: readonly Filter[]): Filter =>
  wheres.length === 1 ? wheres[0]! : { and: [...wheres] };

/**
 * The expression `name` stands for on `homeTableId`, with the measures it
 * uses substituted and every `where` pushed into the aggregates beneath it.
 * `measures` holds the measures the caller may use, by name; a name missing
 * from it, or on another table, is not found. Pure: it reads no catalogue,
 * so the planner resolves the result as it would a query's own expression.
 */
export const expandMeasure = (
  name: string,
  homeTableId: string,
  measures: ReadonlyMap<string, VisibleMeasure>
): Expansion => {
  let nodes = 0;
  const uses = new Set<string>();
  const counted = () => {
    if (++nodes > MAX_EXPANDED_NODES) {
      throw new MeasureError(
        "too_complex",
        `Measures expand to at most ${MAX_EXPANDED_NODES} operations and aggregates`
      );
    }
  };

  /** An aggregate's argument: no aggregate or measure inside it. */
  const checkArgument = (expr: CalcExpr): void => {
    if (!isObject(expr) || isLiteralObject(expr)) return;
    const [key, operand] = Object.entries(expr)[0] ?? [];
    if (key === undefined) return;
    if (AGGREGATES.has(key) || key === "measure") {
      throw new MeasureError(
        "invalid_operator",
        "An aggregate does not contain another aggregate"
      );
    }
    counted();
    if (key === "case") {
      const { when, else: otherwise } = operand as {
        when: { then: CalcExpr }[];
        else?: CalcExpr;
      };
      for (const branch of when) checkArgument(branch.then);
      if (otherwise !== undefined) checkArgument(otherwise);
    } else if (Array.isArray(operand)) {
      const indexes = EXPRESSION_INDEXES[key];
      operand.forEach((e, i) => {
        if (!indexes || indexes.includes(i)) checkArgument(e as CalcExpr);
      });
    } else {
      checkArgument(operand as CalcExpr);
    }
  };

  interface Expanded {
    expr: CalcExpr;
    /** Holds an aggregate (a measure always does). */
    grouped: boolean;
    /** Reads a column outside any aggregate. */
    bare: boolean;
  }

  /** A formula's expression under the accumulated `wheres`, outside any aggregate. */
  const expand = (
    expr: CalcExpr,
    wheres: readonly Filter[],
    stack: readonly string[]
  ): Expanded => {
    if (typeof expr === "string") {
      return { expr, grouped: false, bare: true };
    }
    if (!isObject(expr) || isLiteralObject(expr)) {
      return { expr, grouped: false, bare: false };
    }
    const [key, operand] = Object.entries(expr)[0] as [string, unknown];
    if (key === "measure") {
      return {
        expr: measure(operand as string, wheres, stack),
        grouped: true,
        bare: false,
      };
    }
    counted();
    if (AGGREGATES.has(key)) {
      const arg = operand as CalcExpr;
      checkArgument(arg);
      if (wheres.length === 0) return { expr, grouped: true, bare: false };
      // The `case` wrapped around the argument is one more operation.
      counted();
      const then = key === "count" && arg === "*" ? 1 : arg;
      return {
        expr: {
          [key]: { case: { when: [{ if: conditionOf(wheres), then }] } },
        } as CalcExpr,
        grouped: true,
        bare: false,
      };
    }
    if (key === "case") {
      const { when, else: otherwise } = operand as {
        when: { if: Filter; then: CalcExpr }[];
        else?: CalcExpr;
      };
      // An `if` outside an aggregate reads its columns per row.
      let bare = when.length > 0;
      let grouped = false;
      const branches = when.map((branch) => {
        const then = expand(branch.then, wheres, stack);
        grouped ||= then.grouped;
        bare ||= then.bare;
        return { if: branch.if, then: then.expr };
      });
      const elseExpanded =
        otherwise === undefined ? undefined : expand(otherwise, wheres, stack);
      return {
        expr: {
          case: {
            when: branches,
            ...(elseExpanded ? { else: elseExpanded.expr } : {}),
          },
        },
        grouped: grouped || (elseExpanded?.grouped ?? false),
        bare: bare || (elseExpanded?.bare ?? false),
      };
    }
    if (Array.isArray(operand)) {
      const indexes = EXPRESSION_INDEXES[key];
      let grouped = false;
      let bare = false;
      const operands = operand.map((e, i) => {
        if (indexes && !indexes.includes(i)) return e as unknown;
        const done = expand(e as CalcExpr, wheres, stack);
        grouped ||= done.grouped;
        bare ||= done.bare;
        return done.expr;
      });
      return { expr: { [key]: operands } as CalcExpr, grouped, bare };
    }
    const done = expand(operand as CalcExpr, wheres, stack);
    return { ...done, expr: { [key]: done.expr } as CalcExpr };
  };

  /** The expression measure `ref` stands for, used under `wheres` from the measures on `stack`. */
  const measure = (
    ref: string,
    wheres: readonly Filter[],
    stack: readonly string[]
  ): CalcExpr => {
    const found = measures.get(ref);
    if (!found || found.tableId !== homeTableId) {
      throw new MeasureError(
        "not_found_or_not_accessible",
        `Measure "${ref}" was not found or is not accessible`
      );
    }
    if (stack.includes(ref)) {
      throw new MeasureError(
        "measure_cycle",
        `"${ref}" uses itself: ${[...stack, ref].join(" → ")}`
      );
    }
    if (stack.length > MAX_MEASURE_NESTING) {
      throw new MeasureError(
        "measure_too_deep",
        `Measures use other measures at most ${MAX_MEASURE_NESTING} levels deep`
      );
    }
    if (stack.length > 0) uses.add(ref);
    // The measure's own `where` is the innermost condition.
    const inner = found.where ? [found.where, ...wheres] : wheres;
    const done = expand(found.formula, inner, [...stack, ref]);
    if (done.bare || !done.grouped) {
      throw new MeasureError(
        "measure_not_aggregate",
        `"${ref}" must be group-level: every column it reads inside an aggregate`
      );
    }
    return done.expr;
  };

  const expr = measure(name, [], []);
  return {
    expr,
    relationPaths: relationPathsOf(expr),
    uses: [...uses],
    nodes,
  };
};
