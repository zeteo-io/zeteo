import { ValidationError } from "./errors.js";
import { z } from "zod";

/** An opaque list cursor: the sort key's values, as base64url JSON. */
export const encodeCursor = (values: (string | number)[]): string =>
  Buffer.from(JSON.stringify(values)).toString("base64url");

export const decodeCursor = (
  cursor: string,
  arity: number
): (string | number)[] => {
  const invalid = () => new ValidationError("Invalid cursor");
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalid();
  let values: unknown;
  try {
    values = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
  if (
    !Array.isArray(values) ||
    values.length !== arity ||
    !values.every((v) => typeof v === "string" || typeof v === "number")
  ) {
    throw invalid();
  }
  return values as (string | number)[];
};

/** A cursor's timestamp: ISO 8601 in UTC with milliseconds, as `Date#toISOString` writes it. */
export const CursorDateSchema = z.iso.datetime({ precision: 3 }).refine((v) => {
  const date = new Date(v);
  return !Number.isNaN(date.getTime()) && date.toISOString() === v;
});

/** Decodes `cursor` and checks each value against `schema`, a tuple of the sort key's types. */
export const parseCursor = <T extends z.ZodTuple>(
  cursor: string,
  schema: T
): z.output<T> => {
  const parsed = schema.safeParse(
    decodeCursor(cursor, schema.def.items.length)
  );
  if (!parsed.success) throw new ValidationError("Invalid cursor");
  return parsed.data;
};
