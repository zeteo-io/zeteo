import type { RuleColumn, RuleDescriptionPart } from "./resolve.js";
import type { RelativeDate } from "../adapters/sql/relative.js";
import { isRelativeDate } from "../adapters/sql/relative.js";
import type { RuleCondition, RuleFilter } from "./types.js";
import { isIdentityRef, opOf } from "./store.js";

// A row rule in plain words, for the person it limits (and for an admin
// looking at someone's access). A column is named only when the reader is
// granted it: a condition on any other column is "some rows only", so the
// sentence never reveals a hidden column. Identity keys are named by their
// label; the reader's values under them are never an input here.

/** What a condition on a column the reader may not see reads as. */
export const SOME_ROWS = "some rows only";

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

const unitName = (unit: string) => unit.replace("_", " ");

/** A relative date as a phrase: "now", "90 days ago", "the start of this month". */
const relativePhrase = ({ relative }: RelativeDate): string => {
  const unit = unitName(relative.unit);
  const { offset } = relative;
  if (relative.startOf) {
    if (offset === 0) return `the start of this ${unit}`;
    if (offset === -1) return `the start of last ${unit}`;
    if (offset === 1) return `the start of next ${unit}`;
    return `the start of the ${unit} ${plural(Math.abs(offset), unit)} ${offset < 0 ? "ago" : "from now"}`;
  }
  if (offset === 0) return "now";
  return `${plural(Math.abs(offset), unit)} ${offset < 0 ? "ago" : "from now"}`;
};

const value = (v: unknown): string =>
  isRelativeDate(v) ? relativePhrase(v) : String(v);

const isTemporal = (column: RuleColumn, v: unknown) =>
  column.type === "date" || column.type === "timestamp" || isRelativeDate(v);

const COMPARISONS = {
  gt: ["is after", "is more than"],
  gte: ["is on or after", "is at least"],
  lt: ["is before", "is less than"],
  lte: ["is on or before", "is at most"],
} as const;

/** One condition on a column the reader is granted. */
const describeCondition = (
  column: RuleColumn,
  condition: RuleCondition,
  keyLabels: Map<string, string>
): string => {
  const name = column.name;
  const [op, raw] = opOf(condition);
  if (isIdentityRef(raw)) {
    const label = keyLabels.get(raw.identity) ?? "identity";
    return op === "eq" || op === "in"
      ? `${name} is your ${label}`
      : `${name} is none of your ${label}`;
  }
  switch (op) {
    case "eq":
      return `${name} is ${value(raw)}`;
    case "ne":
      return `${name} is not ${value(raw)}`;
    case "in":
      return `${name} is one of ${(raw as unknown[]).map(value).join(", ")}`;
    case "notIn":
      return `${name} is none of ${(raw as unknown[]).map(value).join(", ")}`;
    case "between": {
      const [from, to] = raw as [unknown, unknown];
      return `${name} is between ${value(from)} and ${value(to)}`;
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      // "from the last 90 days": a window reaching back to now.
      if (
        (op === "gte" || op === "gt") &&
        isRelativeDate(raw) &&
        !raw.relative.startOf &&
        raw.relative.offset < 0
      ) {
        const n = -raw.relative.offset;
        const unit = unitName(raw.relative.unit);
        return `${name} from the last ${n === 1 ? unit : plural(n, unit)}`;
      }
      const [temporal, numeric] = COMPARISONS[op];
      return `${name} ${isTemporal(column, raw) ? temporal : numeric} ${value(raw)}`;
    }
    case "contains":
      return `${name} contains "${String(raw)}"`;
    case "startsWith":
      return `${name} starts with "${String(raw)}"`;
    case "isNull":
      return raw ? `${name} is empty` : `${name} is not empty`;
    case "isBusinessDay":
      return raw
        ? `${name} is a business day`
        : `${name} is not a business day`;
  }
};

/** A sentence and whether it joins several pieces (so needs brackets inside another). */
type Piece = { text: string; compound: boolean };

/** Pieces joined by a word; repeats (several hidden conditions) said once. */
const join = (pieces: Piece[], word: "and" | "or"): Piece => {
  const kept = [...new Map(pieces.map((p) => [p.text, p])).values()];
  if (kept.length === 1) return kept[0];
  return {
    text: kept
      .map((p) => (p.compound ? `(${p.text})` : p.text))
      .join(` ${word} `),
    compound: true,
  };
};

const describeFilter = (
  rule: RuleFilter,
  granted: ReadonlySet<string>,
  columns: Map<string, RuleColumn>,
  keyLabels: Map<string, string>
): Piece => {
  const inner = (f: RuleFilter) =>
    describeFilter(f, granted, columns, keyLabels);
  if ("and" in rule && Array.isArray(rule.and)) {
    return join((rule.and as RuleFilter[]).map(inner), "and");
  }
  if ("or" in rule && Array.isArray(rule.or)) {
    return join((rule.or as RuleFilter[]).map(inner), "or");
  }
  if ("not" in rule && typeof rule.not === "object" && rule.not !== null) {
    const negated = inner(rule.not as RuleFilter);
    // "Not" of a hidden condition is still only some rows.
    return negated.text === SOME_ROWS
      ? negated
      : { text: `not (${negated.text})`, compound: false };
  }
  const pieces = Object.entries(rule as Record<string, RuleCondition>).map(
    ([columnId, condition]): Piece => {
      const column = columns.get(columnId);
      return {
        text:
          column && granted.has(columnId)
            ? describeCondition(column, condition, keyLabels)
            : SOME_ROWS,
        compound: false,
      };
    }
  );
  return join(pieces, "and");
};

/**
 * The rows a caller's rules give them, in words: per grant its own
 * description, else a sentence generated from its stored rule; grants joined
 * with "; or ". `granted` holds the column ids the reader may see; `columns`
 * names the rules' columns by id; `keyLabels` labels identity keys by id.
 */
export const describeRowRule = (
  parts: RuleDescriptionPart[],
  granted: ReadonlySet<string>,
  columns: Map<string, RuleColumn>,
  keyLabels: Map<string, string>
): string =>
  parts
    .map((part) =>
      part.custom !== null && part.custom.trim() !== ""
        ? part.custom
        : describeFilter(part.stored, granted, columns, keyLabels).text
    )
    .join("; or ");
