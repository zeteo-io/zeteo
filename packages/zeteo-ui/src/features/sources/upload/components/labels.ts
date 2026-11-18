import type { FileColumnType } from "../api/types";

const TYPE_NAMES: Record<FileColumnType, string> = {
  text: "Text",
  number: "Number",
  boolean: "True/false",
  date: "Date",
  timestamp: "Date and time",
};

export { formatBytes } from "@/utils/formatBytes";

/** A column type in words. */
export const columnTypeName = (type: FileColumnType): string =>
  TYPE_NAMES[type] ?? type;

/** The rows of a `cast_failed`, as "3, 7 and 12". */
export const listRows = (rows: number[]): string =>
  rows.length <= 1
    ? rows.join("")
    : `${rows.slice(0, -1).join(", ")} and ${rows[rows.length - 1]}`;

/** The address of My Zeteo's My sources tab. */
export const MY_DATA_HREF = "/my?tab=sources";

/** Where an upload source is made from a file. */
export const ADD_DATA_HREF = "/my/data/new";

/** Said before a column's type changes. */
export const RETYPE_WARNING =
  "Saved queries and dashboards that use this column may stop working with the new type.";
