import type { ColumnType } from "../types.js";

const TEXT = new Set([
  "char",
  "varchar",
  "nchar",
  "nvarchar",
  "text",
  "ntext",
  "uniqueidentifier",
  "xml",
]);
const NUMBER = new Set([
  "tinyint",
  "smallint",
  "int",
  "bigint",
  "decimal",
  "numeric",
  "money",
  "smallmoney",
  "float",
  "real",
]);
const TIMESTAMP = new Set([
  "datetime",
  "datetime2",
  "smalldatetime",
  "datetimeoffset",
]);

/** By the column's system type name; alias types are passed as their base type. */
export const mapAzureSqlType = (name: string): ColumnType => {
  if (TEXT.has(name)) return "text";
  if (NUMBER.has(name)) return "number";
  if (name === "bit") return "boolean";
  if (name === "date") return "date";
  if (TIMESTAMP.has(name)) return "timestamp";
  return "other";
};

const LENGTH = new Set(["char", "varchar", "binary", "varbinary"]);
const NATIONAL = new Set(["nchar", "nvarchar"]);
const FRACTIONAL_SECONDS = new Set(["datetime2", "datetimeoffset", "time"]);

/**
 * The type as SQL Server writes it, from `sys.columns`: `max_length` is in
 * bytes (two per national character, -1 for `max`), `scale` is the fractional
 * seconds of the time types.
 */
export const azureSqlNativeType = (column: {
  name: string;
  maxLength: number;
  precision: number;
  scale: number;
}): string => {
  const { name, maxLength, precision, scale } = column;
  if (LENGTH.has(name) || NATIONAL.has(name)) {
    if (maxLength === -1) return `${name}(max)`;
    return `${name}(${NATIONAL.has(name) ? maxLength / 2 : maxLength})`;
  }
  if (name === "decimal" || name === "numeric") {
    return `${name}(${precision},${scale})`;
  }
  if (FRACTIONAL_SECONDS.has(name)) return `${name}(${scale})`;
  return name;
};
