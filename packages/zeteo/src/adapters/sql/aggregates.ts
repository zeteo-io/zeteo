import type { ResolvedExpr, ResolvedSelect } from "./types.js";

// Shared by the planner and the compiler, apart from both so neither imports the other.

/** Whether an expression aggregates the query's own rows; a fixed measure's aggregates are its own. */
const exprAggregates = (expr: ResolvedExpr): boolean => {
  switch (expr.kind) {
    case "aggregate":
    case "pivot":
      return true;
    case "column":
    case "literal":
    case "scalar":
      return false;
    case "dateAdd":
    case "datePart":
      return exprAggregates(expr.arg);
    case "dateDiff":
      return exprAggregates(expr.start) || exprAggregates(expr.end);
    case "businessDays":
      return exprAggregates(expr.start.expr) || exprAggregates(expr.end.expr);
    case "businessPeriod":
      return exprAggregates(expr.date.expr);
    case "addBusinessDays":
      return exprAggregates(expr.date.expr) || exprAggregates(expr.amount);
    case "case":
      return [...expr.branches.map((b) => b.then), expr.otherwise].some(
        (e) => e !== undefined && exprAggregates(e)
      );
    case "op":
      return expr.args.some(exprAggregates);
  }
};

/** Whether a select item aggregates the query's own rows. */
export const aggregatesRows = (item: ResolvedSelect): boolean =>
  item.kind === "aggregate" ||
  (item.kind === "calc" && exprAggregates(item.expr));
