import type { SnapshotForeignKey } from "../adapters/types.js";

/** Tried in this order on the snake-cased column, and the first the name ends in is removed; the `_` forms come first so `product_id` loses `_id`, not `id`. */
const KEY_SUFFIXES = ["_id", "_key", "_sk", "_fk", "id", "key"];

/** The longest relation name, as the declared-name pattern allows. */
const MAX_NAME = 63;

/** camelCase boundaries become `_`, the rest is lower-cased, and other characters become `_`. */
const snake = (raw: string): string =>
  raw
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_");

/**
 * Turns a database identifier into a name matching `^[a-z][a-z0-9_]{0,62}$`:
 * camelCase boundaries become `_`, everything is lower-cased, other characters
 * become `_`, a name not starting with a letter gets `r_` in front, and an
 * empty one is `relation`.
 */
const normalise = (raw: string): string => {
  let name = snake(raw);
  if (name === "") name = "relation";
  if (!/^[a-z]/.test(name)) name = `r_${name}`;
  return name.slice(0, MAX_NAME);
};

/**
 * The part of the names up to and including the first `_` when every column
 * shares it and there are at least two columns (`ws_a`, `ws_b` give `ws_`).
 */
export const columnPrefixOf = (columns: readonly string[]): string | null => {
  if (columns.length < 2) return null;
  const prefix = /^[^_]*_/.exec(columns[0])?.[0];
  if (!prefix) return null;
  return columns.every((c) => c.startsWith(prefix)) ? prefix : null;
};

/** A key column without the table's column prefix and one key suffix; "" when nothing is left. */
const cleanColumn = (column: string, columnPrefix: string | null): string => {
  let name = snake(column);
  const prefix = columnPrefix === null ? "" : snake(columnPrefix);
  if (prefix !== "" && name.startsWith(prefix))
    name = name.slice(prefix.length);
  const suffix = KEY_SUFFIXES.find((s) => name.endsWith(s));
  return suffix ? name.slice(0, -suffix.length) : name;
};

/**
 * The name of the relation on the foreign key's own table. With one key to the
 * target table it is the target's name; with several, the name comes from the
 * key's column (single column) or the target plus its first column (several).
 */
export const forwardName = (
  fk: SnapshotForeignKey,
  context: { keysToSameTarget: number; columnPrefix: string | null }
): string => {
  if (context.keysToSameTarget === 1) return normalise(fk.to.table);
  const cleaned = cleanColumn(fk.from.columns[0], context.columnPrefix);
  if (cleaned === "") return normalise(fk.to.table);
  if (fk.from.columns.length === 1) return normalise(cleaned);
  return normalise(`${fk.to.table}_${cleaned}`);
};

/** The name of the relation on the referenced table: the table that holds the key. */
export const reverseName = (fk: SnapshotForeignKey): string =>
  normalise(fk.from.table);

/** `name`, or `name_2`, `name_3`, … (cut to 63 characters) for the first one `taken` does not hold. */
export const uniqueName = (
  name: string,
  taken: ReadonlySet<string>
): string => {
  if (!taken.has(name)) return name;
  for (let n = 2; ; n++) {
    const suffix = `_${n}`;
    const candidate = `${name.slice(0, MAX_NAME - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
};
