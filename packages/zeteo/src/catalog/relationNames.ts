import type { SnapshotForeignKey } from "../adapters/types.js";

const KEY_SUFFIXES = ["_id", "Id", "_fk"];

/**
 * The name of the relation on the foreign key's own table: its column without
 * a trailing `_id`, `Id` or `_fk`, or the target table's name when the key has
 * several columns or nothing is left of the column's name.
 */
export const forwardName = (fk: SnapshotForeignKey): string => {
  const [column] = fk.from.columns;
  if (fk.from.columns.length !== 1 || column.toLowerCase() === "id") {
    return fk.to.table;
  }
  const suffix = KEY_SUFFIXES.find((s) => column.endsWith(s));
  const stripped = suffix ? column.slice(0, -suffix.length) : column;
  return stripped === "" ? fk.to.table : stripped;
};

/** The name of the relation on the referenced table: the table that holds the key. */
export const reverseName = (fk: SnapshotForeignKey): string => fk.from.table;

/** `name`, or `name_2`, `name_3`, … for the first one `taken` does not hold. */
export const uniqueName = (
  name: string,
  taken: ReadonlySet<string>
): string => {
  if (!taken.has(name)) return name;
  for (let n = 2; ; n++) {
    const candidate = `${name}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
};
