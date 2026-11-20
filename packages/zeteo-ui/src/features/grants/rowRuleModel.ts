// The row rule builder's state, and its two-way mapping to the API's filter
// (a JSON filter keyed by column name). The builder edits groups of
// conditions, nested one level; a rule that does not fit (deeper nesting,
// `not`, shapes the builder has no control for) does not parse and is shown
// read-only as JSON.

export type Op =
  | "eq"
  | "ne"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "between"
  | "in"
  | "notIn"
  | "contains"
  | "startsWith"
  | "empty"
  | "notEmpty"
  | "last"
  | "mineIn"
  | "mineNotIn";

export type RelativeUnitChoice = "day" | "week" | "month" | "quarter" | "year";

export const RELATIVE_UNIT_CHOICES: RelativeUnitChoice[] = [
  "day",
  "week",
  "month",
  "quarter",
  "year",
];

export interface Condition {
  id: string;
  kind: "condition";
  column: string;
  op: Op;
  /** The value of a single-value operator, and the lower end of "between". */
  text: string;
  /** The upper end of "between". */
  text2: string;
  /** The values of "is one of" and "is none of". */
  list: string[];
  /** The identity key of "is one of my…" and "is none of my…". */
  key: string;
  /** "in the last N <unit>s". */
  n: string;
  unit: RelativeUnitChoice;
  /** A number the rule held for a column whose type is not known here. */
  numeric?: boolean;
  /** A boolean the rule held for a column whose type is not known here. */
  boolean?: boolean;
}

export interface Group {
  id: string;
  kind: "group";
  mode: "and" | "or";
  items: (Condition | Group)[];
}

export type ColumnKind = "number" | "date" | "boolean" | "text";

export interface RuleColumn {
  name: string;
  /** The column's type as the catalogue names it. */
  type: string;
  /** False for a column the grant does not include. */
  inGrant: boolean;
}

export const columnKind = (type: string | undefined): ColumnKind => {
  const t = (type ?? "").toLowerCase();
  if (/bool|bit/.test(t)) return "boolean";
  if (/date|time/.test(t)) return "date";
  if (/int|number|numeric|decimal|float|double|real|money|serial/.test(t)) {
    return "number";
  }
  return "text";
};

let counter = 0;
const nextId = () => `rr-${++counter}`;

export const newCondition = (over: Partial<Condition> = {}): Condition => ({
  id: nextId(),
  kind: "condition",
  column: "",
  op: "eq",
  text: "",
  text2: "",
  list: [],
  key: "",
  n: "90",
  unit: "day",
  ...over,
});

export const newGroup = (
  items: (Condition | Group)[] = [],
  mode: "and" | "or" = "and"
): Group => ({ id: nextId(), kind: "group", mode, items });

/** A fresh rule: one empty group. */
export const emptyRule = (): Group => newGroup([newCondition()]);

// --- Serialising -----------------------------------------------------------

const isNumeric = (c: Condition, columns: RuleColumn[]) =>
  c.numeric ||
  columnKind(columns.find((x) => x.name === c.column)?.type) === "number";

const isBoolean = (c: Condition, columns: RuleColumn[]) =>
  c.boolean ||
  columnKind(columns.find((x) => x.name === c.column)?.type) === "boolean";

const scalar = (
  text: string,
  c: Condition,
  columns: RuleColumn[]
): string | number | boolean => {
  if (isNumeric(c, columns)) {
    const n = Number(text);
    return Number.isFinite(n) && text.trim() !== "" ? n : text;
  }
  if (isBoolean(c, columns)) return text === "true";
  return text;
};

const conditionFilter = (c: Condition, columns: RuleColumn[]): unknown => {
  const one = (text: string) => scalar(text, c, columns);
  switch (c.op) {
    case "eq":
    case "ne":
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return { [c.column]: { [c.op]: one(c.text) } };
    case "between":
      return { [c.column]: { between: [one(c.text), one(c.text2)] } };
    case "in":
    case "notIn":
      return { [c.column]: { [c.op]: c.list.map(one) } };
    case "contains":
    case "startsWith":
      return { [c.column]: { [c.op]: c.text } };
    case "empty":
      return { [c.column]: { isNull: true } };
    case "notEmpty":
      return { [c.column]: { isNull: false } };
    case "last":
      return {
        [c.column]: {
          gte: { relative: { unit: c.unit, offset: -Number(c.n) } },
        },
      };
    case "mineIn":
      return { [c.column]: { in: { identity: c.key } } };
    case "mineNotIn":
      return { [c.column]: { notIn: { identity: c.key } } };
  }
};

const groupFilter = (g: Group, columns: RuleColumn[]): unknown => ({
  [g.mode]: g.items.map((i) =>
    i.kind === "group" ? groupFilter(i, columns) : conditionFilter(i, columns)
  ),
});

/**
 * The API's filter for a draft. A rule of one condition is that condition
 * alone, with no `and` around it.
 */
export const toRule = (root: Group, columns: RuleColumn[]): unknown => {
  const only = root.items.length === 1 ? root.items[0]! : null;
  if (only?.kind === "condition") return conditionFilter(only, columns);
  return groupFilter(root, columns);
};

/** Whether every condition has what it needs, and no group is empty. */
export const isComplete = (node: Condition | Group): boolean => {
  if (node.kind === "group") {
    return node.items.length > 0 && node.items.every(isComplete);
  }
  if (!node.column) return false;
  switch (node.op) {
    case "eq":
    case "ne":
    case "gt":
    case "gte":
    case "lt":
    case "lte":
    case "contains":
    case "startsWith":
      return node.text !== "";
    case "between":
      return node.text !== "" && node.text2 !== "";
    case "in":
    case "notIn":
      return node.list.length > 0;
    case "last": {
      const n = Number(node.n);
      return Number.isInteger(n) && n >= 1 && n <= 1000;
    }
    case "mineIn":
    case "mineNotIn":
      return node.key !== "";
    default:
      return true;
  }
};

// --- Parsing ---------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isScalar = (v: unknown): v is string | number | boolean =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean";

const NOT_PARSED = Symbol("not parsed");
type Parsed<T> = T | typeof NOT_PARSED;

const identityOf = (v: unknown): string | null =>
  isRecord(v) && Object.keys(v).length === 1 && typeof v.identity === "string"
    ? v.identity
    : null;

const hintOf = (v: unknown): { numeric?: true; boolean?: true } =>
  typeof v === "number"
    ? { numeric: true }
    : typeof v === "boolean"
      ? { boolean: true }
      : {};

const parseCondition = (column: string, body: unknown): Parsed<Condition> => {
  if (!isRecord(body)) return NOT_PARSED;
  const ops = Object.keys(body);
  if (ops.length !== 1) return NOT_PARSED;
  const op = ops[0]!;
  const v = body[op];
  const hint = hintOf(v);
  switch (op) {
    case "eq":
    case "ne":
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      if (op === "gte" && isRecord(v) && isRecord(v.relative)) {
        const r = v.relative;
        if (
          Object.keys(v).length === 1 &&
          Object.keys(r).length === 2 &&
          RELATIVE_UNIT_CHOICES.includes(r.unit as RelativeUnitChoice) &&
          typeof r.offset === "number" &&
          r.offset < 0
        ) {
          return newCondition({
            column,
            op: "last",
            n: String(-r.offset),
            unit: r.unit as RelativeUnitChoice,
          });
        }
        return NOT_PARSED;
      }
      return isScalar(v)
        ? newCondition({ column, op, text: String(v), ...hint })
        : NOT_PARSED;
    case "between":
      return Array.isArray(v) &&
        v.length === 2 &&
        v.every(isScalar) &&
        !v.some((x) => isRecord(x))
        ? newCondition({
            column,
            op: "between",
            text: String(v[0]),
            text2: String(v[1]),
            ...hintOf(v[0]),
          })
        : NOT_PARSED;
    case "in":
    case "notIn": {
      const key = identityOf(v);
      if (key !== null) {
        return newCondition({
          column,
          op: op === "in" ? "mineIn" : "mineNotIn",
          key,
        });
      }
      return Array.isArray(v) && v.length > 0 && v.every(isScalar)
        ? newCondition({
            column,
            op,
            list: v.map(String),
            ...hintOf(v[0]),
          })
        : NOT_PARSED;
    }
    case "contains":
    case "startsWith":
      return typeof v === "string"
        ? newCondition({ column, op, text: v })
        : NOT_PARSED;
    case "isNull":
      return typeof v === "boolean"
        ? newCondition({ column, op: v ? "empty" : "notEmpty" })
        : NOT_PARSED;
    default:
      return NOT_PARSED;
  }
};

const parseNode = (
  node: unknown,
  groupDepth: number
): Parsed<Condition | Group> => {
  if (!isRecord(node)) return NOT_PARSED;
  const keys = Object.keys(node);
  if (keys.length !== 1) return NOT_PARSED;
  const key = keys[0]!;
  if (key === "and" || key === "or") {
    if (groupDepth < 1) return NOT_PARSED;
    const list = node[key];
    if (!Array.isArray(list) || list.length === 0) return NOT_PARSED;
    const items: (Condition | Group)[] = [];
    for (const item of list) {
      const parsed = parseNode(item, groupDepth - 1);
      if (parsed === NOT_PARSED) return NOT_PARSED;
      items.push(parsed);
    }
    return newGroup(items, key);
  }
  if (key === "not") return NOT_PARSED;
  return parseCondition(key, node[key]);
};

/**
 * A draft from the API's rule, or null when the builder cannot show it
 * (deeper than one nested group, `not`, or a value it has no control for).
 */
export const parseRule = (rule: unknown): Group | null => {
  const node = parseNode(rule, 2);
  if (node === NOT_PARSED) return null;
  return node.kind === "group" ? node : newGroup([node]);
};

// --- Error paths -----------------------------------------------------------

/**
 * The id of the condition (or group) an `invalid_row_rule` path points at, for
 * a draft serialised with `toRule`. The path starts with `row_rule`.
 */
export const locate = (
  root: Group,
  path: (string | number)[] | undefined
): string | null => {
  if (!path || path[0] !== "row_rule") return null;
  const rest = path.slice(1);
  const only = root.items.length === 1 ? root.items[0]! : null;
  if (only?.kind === "condition") return only.id;
  let group: Group = root;
  let i = 0;
  while (i < rest.length) {
    if (rest[i] !== group.mode) return group.id;
    const index = rest[i + 1];
    const item = typeof index === "number" ? group.items[index] : undefined;
    if (!item) return group.id;
    if (item.kind === "condition") return item.id;
    group = item;
    i += 2;
  }
  return group.id;
};
