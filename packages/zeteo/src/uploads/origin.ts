import type { ColumnType } from "../adapters/types.js";
import { logger } from "../utils/logger.js";
import { z } from "zod";

/**
 * A merged table's definition, kept in its origin: the label column, the member
 * tables with their labels, and each selected column with the member column it
 * reads in each member (a member missing from `from` contributes NULL).
 */
export type MergedDefinition = {
  labelColumnId: string;
  members: { tableId: string; label: string }[];
  columns: {
    columnId: string;
    type: ColumnType;
    /** Member table id to that member's column id. */
    from: Record<string, string>;
  }[];
  /** Member columns that no longer fit the merged column's type. */
  warnings?: { columnId: string; tableId: string }[];
};

/** Where an upload source's table comes from, as `source_tables.origin` keeps it. */
export type TableOrigin =
  | { kind: "file"; filename: string }
  | {
      kind: "google-sheets";
      spreadsheetId: string;
      spreadsheetTitle: string;
      /** The tab's title; absent only in rows written before it was kept. */
      tabTitle?: string;
      sheetId: number;
      headerRow: number | null;
      removed?: boolean;
    }
  | { kind: "merged"; definition: MergedDefinition };

/** A Google Sheets table's origin. */
export type SheetsOrigin = Extract<TableOrigin, { kind: "google-sheets" }>;

const COLUMN_TYPES = [
  "text",
  "number",
  "boolean",
  "date",
  "timestamp",
  "json",
  "other",
] as const satisfies readonly ColumnType[];

const mergedDefinitionSchema = z.object({
  labelColumnId: z.string(),
  members: z.array(z.object({ tableId: z.string(), label: z.string() })),
  columns: z.array(
    z.object({
      columnId: z.string(),
      type: z.enum(COLUMN_TYPES),
      from: z.record(z.string(), z.string()),
    })
  ),
  warnings: z
    .array(z.object({ columnId: z.string(), tableId: z.string() }))
    .optional(),
});

const originSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file"), filename: z.string() }),
  z.object({
    kind: z.literal("google-sheets"),
    spreadsheetId: z.string(),
    spreadsheetTitle: z.string(),
    tabTitle: z.string().optional(),
    sheetId: z.number().int(),
    headerRow: z.number().int().nullable(),
    removed: z.boolean().optional(),
  }),
  z.object({ kind: z.literal("merged"), definition: mergedDefinitionSchema }),
]);

/**
 * A table's origin, parsed; null when it has none or the stored value is not one
 * (logged at warn, as only Zeteo writes it).
 */
export const originOf = (table: { origin: unknown }): TableOrigin | null => {
  if (table.origin === null || table.origin === undefined) return null;
  const parsed = originSchema.safeParse(table.origin);
  if (parsed.success) return parsed.data;
  logger.warn({ issues: parsed.error.issues }, "Unreadable table origin");
  return null;
};

/** True for a table synced from a Google Sheets tab. */
export const isSheetsTable = (table: { origin: unknown }): boolean =>
  originOf(table)?.kind === "google-sheets";

/** True for a table loaded from an uploaded file. */
export const isFileTable = (table: { origin: unknown }): boolean =>
  originOf(table)?.kind === "file";

/** True for a merged table (a view over other tables of its source). */
export const isMergedTable = (table: { origin: unknown }): boolean =>
  originOf(table)?.kind === "merged";
