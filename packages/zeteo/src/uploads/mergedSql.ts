import type { UploadColumnType } from "./types.js";
import { NATIVE_TYPE } from "./loading.js";
import { quote } from "./storage.js";

/** The longest member label, in characters. */
export const MAX_LABEL_LENGTH = 100;

/** A merged table with its members and columns resolved to physical names. */
export interface ResolvedMerged {
  labelColumn: string;
  columns: { name: string; type: UploadColumnType }[];
  members: {
    physicalTable: string;
    label: string;
    /** Aligned with `columns`; null means this member contributes NULL. */
    columnNames: (string | null)[];
  }[];
}

/** Text as a SQL string literal: quotes doubled, no NUL, at most 100 characters. */
export const sqlLiteral = (text: string): string => {
  if (text.includes("\0")) throw new Error("A label cannot contain NUL");
  if ([...text].length > MAX_LABEL_LENGTH) {
    throw new Error(`A label is at most ${MAX_LABEL_LENGTH} characters`);
  }
  return `'${text.replace(/'/g, "''")}'`;
};

/** `CREATE VIEW` over the members of a merged table, as a UNION ALL. */
export const mergedViewSql = (
  schema: string,
  viewName: string,
  def: ResolvedMerged
): string => {
  if (def.members.length === 0) {
    throw new Error("A merged table needs at least one member");
  }
  const selects = def.members.map((member) => {
    if (member.columnNames.length !== def.columns.length) {
      throw new Error("A member's columns must align with the table's");
    }
    const items = [
      `${sqlLiteral(member.label)}::text AS ${quote(def.labelColumn)}`,
      ...def.columns.map((column, i) => {
        const source = member.columnNames[i];
        const value = source === null ? "NULL" : quote(source);
        return `${value}::${NATIVE_TYPE[column.type]} AS ${quote(column.name)}`;
      }),
    ];
    return `SELECT ${items.join(", ")} FROM ${quote(schema)}.${quote(member.physicalTable)}`;
  });
  return `CREATE VIEW ${quote(schema)}.${quote(viewName)} AS ${selects.join(" UNION ALL ")}`;
};
