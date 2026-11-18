import type { FileColumnType } from "../api/types";

const TYPE_NAMES: Record<FileColumnType, string> = {
  text: "Text",
  number: "Number",
  boolean: "True/false",
  date: "Date",
  timestamp: "Date and time",
};

/** A column type in words. */
export const columnTypeName = (type: FileColumnType): string =>
  TYPE_NAMES[type] ?? type;

const UNITS = ["bytes", "KB", "MB", "GB", "TB"];

/** A size in bytes as "12.3 MB". */
export const formatBytes = (bytes: number): string => {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const shown = unit === 0 ? String(value) : value.toFixed(value < 10 ? 1 : 0);
  return `${shown} ${UNITS[unit]}`;
};

/** The rows of a `cast_failed`, as "3, 7 and 12". */
export const listRows = (rows: number[]): string =>
  rows.length <= 1
    ? rows.join("")
    : `${rows.slice(0, -1).join(", ")} and ${rows[rows.length - 1]}`;

/** The address of My Zeteo's My data tab. */
export const MY_DATA_HREF = "/my?tab=data";

/** A file source's own page. */
export const fileSourceHref = (id: string) => `/my/data/${id}`;
