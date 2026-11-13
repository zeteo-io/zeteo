import { AppError, truncate } from "../utils/errors.js";

export type QueryErrorCode =
  | "not_found_or_not_accessible"
  | "missing_in_source"
  | "column_not_queryable"
  | "invalid_operator"
  | "invalid_value"
  | "invalid_grouping"
  | "invalid_order"
  | "invalid_having"
  | "duplicate_output_name"
  | "join_parent_missing"
  | "too_many_parameters";

/** Where in the query the problem is: keys and array indexes from the root. */
export type QueryPath = (string | number)[];

/** A query that is well formed but cannot be planned. The body adds `path` and `suggestions`. */
export class QueryError extends AppError {
  constructor(
    code: QueryErrorCode,
    message: string,
    public path: QueryPath,
    public suggestions: string[] = []
  ) {
    super(422, code, message, { details: { path, suggestions } });
    this.name = "QueryError";
  }
}

const MAX_SUGGESTIONS = 3;
/** The longest a name from the query is echoed in a message. */
const MAX_NAME_CHARS = 128;

/** Levenshtein distance, or `Infinity` once it must exceed `max`. */
const distance = (a: string, b: string, max: number): number => {
  if (Math.abs(a.length - b.length) > max) return Infinity;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost
      );
      rowMin = Math.min(rowMin, current[j]);
    }
    if (rowMin > max) return Infinity;
    previous = current;
  }
  return previous[b.length];
};

/**
 * Up to three candidates closest to `name`, closest first and ties in
 * alphabetical order. A candidate is close when it is within a third of the
 * length of the name's last segment (at least 2), so a long relation prefix
 * shared by every candidate does not widen the net.
 */
const closest = (name: string, candidates: readonly string[]): string[] => {
  const max = Math.max(2, Math.floor(name.split(".").at(-1)!.length / 3));
  return [...new Set(candidates)]
    .map((c) => ({ c, d: distance(name, c, max) }))
    .filter(({ d }) => d <= max)
    .sort((x, y) => x.d - y.d || (x.c < y.c ? -1 : x.c > y.c ? 1 : 0))
    .slice(0, MAX_SUGGESTIONS)
    .map(({ c }) => c);
};

const KIND_LABEL = {
  source: "Source",
  table: "Table",
  relation: "Relation",
  column: "Column",
} as const;

export const notFoundMessage = (
  kind: keyof typeof KIND_LABEL,
  name: string
): string =>
  `${KIND_LABEL[kind]} "${truncate(name, MAX_NAME_CHARS)}" was not found or is not accessible`;

/**
 * The one error for a name the caller cannot use, whether it does not exist or
 * is not granted. `candidates` must hold only names the caller may see.
 */
export const notFound = (
  kind: keyof typeof KIND_LABEL,
  name: string,
  path: QueryPath,
  candidates: readonly string[]
): QueryError =>
  new QueryError(
    "not_found_or_not_accessible",
    notFoundMessage(kind, name),
    path,
    closest(name, candidates)
  );
