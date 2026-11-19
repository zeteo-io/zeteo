import type { Measure } from "../../prisma/generated/client/index.js";
import type { ShareView } from "../sharing/shares.js";

/** How many saved queries use a measure, and how many dashboard panels show one of them. */
export interface UsedBy {
  saved_queries: number;
  panels: number;
}

/** Why a measure does not plan against its source's catalogue: a missing column, too many joins. */
export interface Broken {
  code: string;
  message: string;
}

/**
 * A measure in full: its definition, whether the caller may use it, and,
 * for editors and admins, what uses it; for those who see every measure,
 * whether it is broken.
 */
export const measureView = (
  row: Measure,
  table: string,
  extra: { usable: boolean; usedBy?: UsedBy; broken?: Broken | null }
) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  table,
  formula: row.formula,
  where: row.where ?? null,
  fixed: row.fixed,
  date_column: row.dateColumn,
  created_at: row.createdAt.toISOString(),
  updated_at: row.updatedAt.toISOString(),
  usable: extra.usable,
  ...(extra.usedBy !== undefined && { used_by: extra.usedBy }),
  ...(extra.broken !== undefined && { broken: extra.broken }),
});

/**
 * A measure an editor cannot fully see: never its formula or filter, which
 * would name columns and values the editor is not granted.
 */
export const redactedMeasureView = (row: Measure, table: string) => ({
  name: row.name,
  description: row.description,
  table,
  usable: false as const,
});

export type MeasureView = ReturnType<typeof measureView>;
export type RedactedMeasureView = ReturnType<typeof redactedMeasureView>;

/** A source's measure editor, as `GET` and `PUT .../measure-editors` list it: a share's view, named as an editor's. */
export const measureEditorView = ({ shared_at, ...principal }: ShareView) => ({
  ...principal,
  added_at: shared_at,
});

export type MeasureEditorView = ReturnType<typeof measureEditorView>;
