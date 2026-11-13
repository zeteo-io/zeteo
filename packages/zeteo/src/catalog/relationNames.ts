import type { SnapshotForeignKey } from "../adapters/types.js";

const KEY_SUFFIXES = ["_id", "Id", "_fk"];

/** The longest relation name, as the declared-name pattern allows. */
const MAX_NAME = 63;

/**
 * Turns a database identifier into a name matching `^[a-z][a-z0-9_]{0,62}$`:
 * camelCase boundaries become `_`, everything is lower-cased, other characters
 * become `_`, a name not starting with a letter gets `r_` in front, and an
 * empty one is `relation`.
 */
const normalise = (raw: string): string => {
  let name = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_");
  if (name === "") name = "relation";
  if (!/^[a-z]/.test(name)) name = `r_${name}`;
  return name.slice(0, MAX_NAME);
};

/**
 * The name of the relation on the foreign key's own table: its column without
 * a trailing `_id`, `Id` or `_fk`, or the target table's name when the key has
 * several columns or nothing is left of the column's name.
 */
export const forwardName = (fk: SnapshotForeignKey): string => {
  const [column] = fk.from.columns;
  if (fk.from.columns.length !== 1 || column.toLowerCase() === "id") {
    return normalise(fk.to.table);
  }
  const suffix = KEY_SUFFIXES.find((s) => column.endsWith(s));
  const stripped = suffix ? column.slice(0, -suffix.length) : column;
  return normalise(stripped === "" ? fk.to.table : stripped);
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
