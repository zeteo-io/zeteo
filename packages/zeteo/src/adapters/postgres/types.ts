import type { ColumnType } from "../types.js";

const NUMBER = new Set([
  "int2",
  "int4",
  "int8",
  "numeric",
  "float4",
  "float8",
  "money",
]);
const TEXT = new Set(["text", "varchar", "bpchar", "citext", "uuid", "name"]);

/**
 * `typtype` is pg_type's kind: `e` enum, `d` domain (mapped through its base
 * type, passed as `base`), `b` base. Arrays are `_`-prefixed base types.
 */
export const mapPostgresType = (
  typname: string,
  typtype: string,
  base?: { typname: string; typtype: string } | null
): ColumnType => {
  if (typtype === "d") {
    return base ? mapPostgresType(base.typname, base.typtype) : "other";
  }
  if (typtype === "e") return "text";
  if (NUMBER.has(typname)) return "number";
  if (TEXT.has(typname)) return "text";
  if (typname === "bool") return "boolean";
  if (typname === "date") return "date";
  if (typname === "timestamp" || typname === "timestamptz") return "timestamp";
  if (typname === "json" || typname === "jsonb") return "json";
  return "other";
};
