import { ConflictError } from "./errors.js";

/**
 * True if `err` is a foreign-key/restrict violation: a delete blocked because
 * other rows still reference the record, or a write naming a row that does
 * not exist. Detected by code, not `instanceof`: the Prisma error class
 * differs between generated clients.
 *
 * Several shapes occur in practice: Prisma's mapped `P2003`; the raw
 * `DriverAdapterError` from the pg driver adapter; and a Prisma error wrapping
 * that adapter error in `meta.driverAdapterError` (`P2039` from the client,
 * `P2010` from raw SQL). The adapter carries the Postgres SQLSTATE as
 * `originalCode` (and, for errors it does not classify, also as `code`):
 * `23001` (restrict_violation, raised by `ON DELETE RESTRICT`) or `23503`
 * (foreign_key_violation), neither of which Prisma maps to `P2003`.
 */
export function isForeignKeyConstraintError(err: unknown): boolean {
  const codes = pgErrorCodes(err);
  return ["P2003", "23001", "23503"].some((c) => codes.includes(c));
}

/**
 * True if `err` is a unique-constraint violation: `P2002`, or SQLSTATE `23505`
 * from the driver adapter in any of the shapes above.
 */
export function isUniqueConstraintError(err: unknown): boolean {
  const codes = pgErrorCodes(err);
  return codes.includes("P2002") || codes.includes("23505");
}

/** Runs `fn`; a unique violation becomes `ConflictError(message, code)`, anything else is rethrown. */
export async function mapUniqueViolation<T>(
  fn: () => Promise<T>,
  message: string,
  code: string
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isUniqueConstraintError(err)) throw new ConflictError(message, code);
    throw err;
  }
}

/**
 * True if `err` is a unique violation of `table`'s constraint. The adapter names the violated index and table
 * (`cause.constraint.index`, `cause.table`). A `P2002` carrying only `meta.target` is matched by `columns`.
 */
export function isUniqueViolationOn(
  err: unknown,
  table: string,
  columns: string[]
): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as {
    meta?: { target?: unknown; driverAdapterError?: { cause?: AdapterCause } };
    cause?: AdapterCause;
  };
  const cause = e.meta?.driverAdapterError?.cause ?? e.cause;
  if (!isUniqueConstraintError(err)) return false;
  if (typeof cause?.table === "string" && cause.table !== table) return false;
  const index = cause?.constraint?.index;
  if (typeof index === "string") return index.startsWith(`${table}_`);
  if (typeof cause?.table === "string") return true;
  const target = cause?.constraint?.fields ?? e.meta?.target;
  return (
    Array.isArray(target) &&
    columns.every((c) => target.map(String).includes(c))
  );
}

interface AdapterCause {
  kind?: unknown;
  originalCode?: unknown;
  constraint?: { fields?: unknown; index?: unknown };
  table?: unknown;
}

/**
 * `err`, its cause chain and the driver adapter error Prisma wraps, which
 * nest differently by version.
 */
export const errorChain = (err: unknown): Record<string, unknown>[] => {
  const chain: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  const walk = (e: unknown) => {
    if (!e || typeof e !== "object" || seen.has(e)) return;
    seen.add(e);
    const o = e as Record<string, unknown>;
    chain.push(o);
    for (const key of ["cause", "meta", "driverAdapterError"]) {
      walk(o[key]);
    }
  };
  walk(err);
  return chain;
};

/** Every Postgres SQLSTATE or Prisma code found on `errorChain(err)`. */
export const pgErrorCodes = (err: unknown): string[] =>
  errorChain(err).flatMap((o) =>
    ["code", "originalCode"]
      .map((key) => o[key])
      .filter((v): v is string => typeof v === "string")
  );
