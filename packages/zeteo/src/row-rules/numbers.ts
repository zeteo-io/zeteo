import { InvalidRowRuleError } from "../utils/errors.js";

// A JSON number is parsed to a double. A rule must compare with the number
// its text says, not a neighbour the double rounded it to, so a number whose
// text and parsed value differ is refused, asking for a decimal string.

/** A JSON number a double did not keep as written: its text, as sent. */
export class RoundedNumber {
  constructor(readonly source: string) {}
}

const NUMBER_TEXT = /^(-?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

/**
 * A number's text as its significant digits and the power of ten of the
 * first (`<digits>e<exponent>`), the same for every way of writing one
 * number: `1.50`, `15e-1` and `0.0015E3` alike.
 */
const canonical = (text: string): string | undefined => {
  const m = NUMBER_TEXT.exec(text);
  if (!m) return undefined;
  const whole = m[2]!;
  const all = whole + (m[3] ?? "");
  const leading = all.length - all.replace(/^0+/, "").length;
  const digits = all.slice(leading).replace(/0+$/, "");
  if (digits === "") return "0";
  const exponent = whole.length - leading - 1 + Number(m[4] ?? 0);
  return `${m[1]}${digits}e${exponent}`;
};

/**
 * Whether `n`, parsed from the JSON text `source`, is the number written:
 * the text's digits and scale are those of the double's shortest form.
 */
export const writtenExactly = (source: string, n: number): boolean =>
  Number.isFinite(n) && canonical(source) === canonical(String(n));

const NO_SOURCE_TEXT =
  "JSON.parse gave a reviver no number's source text (Node 21 or later does)";

/**
 * A `JSON.parse` reviver that puts a `RoundedNumber` in place of each number
 * a double did not keep as written (Node passes each number's source text).
 * Without the source text it cannot tell, so it throws rather than pass the
 * number on: the body is refused, never stored rounded.
 */
export const markRounded = function (
  this: unknown,
  _key: string,
  value: unknown,
  context?: { source?: string }
): unknown {
  if (typeof value !== "number") return value;
  if (typeof context?.source !== "string") throw new Error(NO_SOURCE_TEXT);
  return writtenExactly(context.source, value)
    ? value
    : new RoundedNumber(context.source);
};

/**
 * Throws unless `JSON.parse` passes a reviver each number's source text,
 * which `markRounded` needs: checked once at start-up, so a runtime without
 * it never serves a grant.
 */
export const checkJsonSourceText = (): void => {
  let source: unknown;
  JSON.parse("[9007199254740993]", function (
    this: unknown,
    key: string,
    value: unknown,
    context?: { source?: string }
  ) {
    if (key === "0") source = context?.source;
    return value;
  } as Parameters<typeof JSON.parse>[1]);
  if (source !== "9007199254740993") throw new Error(NO_SOURCE_TEXT);
};

/** `text` parsed as `express.json` parses a grant's body. */
export const parseRuleBody = (text: string): unknown =>
  JSON.parse(text, markRounded as Parameters<typeof JSON.parse>[1]);

/**
 * Refuses the first `RoundedNumber` under `row_rule` in a parsed grant body
 * (`400 invalid_row_rule` at its path); one elsewhere, where no number is
 * compared with a column, is put back as the number it parsed to.
 */
export const refuseRoundedNumbers = (body: unknown): void => {
  const walk = (value: unknown, path: (string | number)[]): unknown => {
    if (value instanceof RoundedNumber) {
      if (path[0] === "row_rule") {
        throw new InvalidRowRuleError(
          `${value.source} cannot be held exactly as a JSON number; write it as a decimal string`,
          path
        );
      }
      return Number(value.source);
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        value[i] = walk(item, [...path, i]);
      });
    } else if (typeof value === "object" && value !== null) {
      for (const key of Object.keys(value)) {
        // Defined, not assigned: a `__proto__` key stays an own property.
        Object.defineProperty(value, key, {
          value: walk((value as Record<string, unknown>)[key], [...path, key]),
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
    }
    return value;
  };
  walk(body, []);
};
