import type { ChartSettings, ChartType, ResultColumn } from "./api/types";

// What the panel editor works out from a saved query and its result: the
// chart type to suggest, its first settings, and the time columns it can use.

const isNumber = (c: ResultColumn) => c.type === "number";
const isTime = (c: ResultColumn) => c.type === "date" || c.type === "timestamp";
const isText = (c: ResultColumn) => c.type === "text";

/**
 * The chart that suits a result: one row with one number column is a stat; a
 * date or timestamp plus numbers, a line; text plus a number, a bar;
 * anything else, a table.
 */
export const suggestChart = (
  columns: readonly ResultColumn[],
  rowCount?: number
): ChartType => {
  const numbers = columns.filter(isNumber).length;
  if (rowCount === 1 && numbers === 1) return "stat";
  if (numbers > 0 && columns.some(isTime)) return "line";
  if (numbers > 0 && columns.some(isText)) return "bar";
  return "table";
};

/** First settings of a chart of `type` over `columns`, filled from the columns that fit. */
export const defaultChart = (
  type: ChartType,
  columns: readonly ResultColumn[]
): ChartSettings => {
  const first = (test: (c: ResultColumn) => boolean) =>
    columns.find(test)?.name ?? "";
  const numbers = (except?: string) =>
    columns
      .filter((c) => isNumber(c) && c.name !== except)
      .slice(0, 10)
      .map((c) => c.name);
  switch (type) {
    case "stat":
      return { type, version: 1, value: first(isNumber) };
    case "line":
    case "area": {
      const x = first(isTime) || first(isNumber);
      return { type, version: 1, x, y: numbers(x) };
    }
    case "bar": {
      const x =
        first(isText) || first((c) => !isNumber(c)) || first(() => true);
      return { type, version: 1, x, y: numbers(x) };
    }
    case "pie":
      return { type, version: 1, label: first(isText), value: first(isNumber) };
    case "gauge": {
      const [value = "", max = ""] = numbers();
      return { type, version: 1, value, max };
    }
    case "table":
      return { type, version: 1 };
  }
};

/** A source's catalogue as `GET /v1/catalog` gives it, as far as the editor reads it. */
export interface CatalogSourceColumns {
  slug: string;
  tables: {
    name: string;
    columns?: { name: string; type: string; missing?: boolean }[];
    relations?: { name: string; to: string; missing?: boolean }[];
  }[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const joinPaths = (query: Record<string, unknown>): string[] =>
  Array.isArray(query.join)
    ? query.join.flatMap((j) =>
        typeof j === "string"
          ? [j]
          : isRecord(j) && typeof j.relation === "string"
            ? [j.relation]
            : []
      )
    : [];

/**
 * The date and timestamp column paths a saved query can filter on: those of
 * its `from` table, then of each relation it joins (`orders.created_at`), as
 * the query language names them.
 */
export const timeColumnOptions = (
  query: unknown,
  catalog: CatalogSourceColumns | undefined
): string[] => {
  if (!isRecord(query) || typeof query.from !== "string" || !catalog) return [];
  const table = (name: string) => catalog.tables.find((t) => t.name === name);
  const timeColumns = (name: string, prefix: string) =>
    (table(name)?.columns ?? [])
      .filter(
        (c) => !c.missing && (c.type === "date" || c.type === "timestamp")
      )
      .map((c) => `${prefix}${c.name}`);

  const out = timeColumns(query.from, "");
  for (const path of joinPaths(query)) {
    let at: string | undefined = query.from;
    for (const step of path.split(".")) {
      at = table(at)?.relations?.find((r) => r.name === step && !r.missing)?.to;
      if (at === undefined) break;
    }
    if (at !== undefined) out.push(...timeColumns(at, `${path}.`));
  }
  return [...new Set(out)];
};

/** The column behind the query's first date bucket (`{ bucket, column }`), the time column to suggest. */
export const bucketColumn = (query: unknown): string | undefined => {
  if (!isRecord(query) || !Array.isArray(query.select)) return undefined;
  for (const item of query.select) {
    if (isRecord(item) && "bucket" in item && typeof item.column === "string") {
      return item.column;
    }
  }
  return undefined;
};

/** What a server `invalid_panel` problem means, in words for the field it sits beside. */
export const problemText = (problem: string): string => {
  switch (problem) {
    case "missing_column":
      return "The saved query's result has no such column.";
    case "wrong_type":
      return "This column's type does not fit this setting.";
    case "needs_order":
      return "Comparing rows needs the saved query to sort them (orderBy).";
    case "not_available":
      return "This saved query is no longer available for dashboards.";
    case "not_accessible":
      return "You need expanded permissions to run this saved query. Ask an admin to extend your access.";
    default:
      return "This setting does not fit the saved query.";
  }
};

/** The field a problem's setting belongs to: `y.1` is the `y` field. */
export const fieldOf = (setting: string) => setting.split(".")[0] ?? setting;
