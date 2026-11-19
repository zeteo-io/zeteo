// Field for field the server's `measureView` and `redactedMeasureView`.

/** How many saved queries use a measure, and how many dashboard panels show one of them. */
export interface UsedBy {
  saved_queries: number;
  panels: number;
}

/** Why a measure does not plan against its source's catalogue. */
export interface Broken {
  code: string;
  message: string;
}

/** A measure the caller sees in full. */
export interface Measure {
  id: string;
  name: string;
  description: string;
  /** As a query names it: bare, or `schema.name` where the bare name is not unique. */
  table: string;
  formula: unknown;
  where: unknown;
  created_at: string;
  updated_at: string;
  usable: boolean;
  /** Editors and admins only. */
  used_by?: UsedBy;
  /** Those who see every measure; null when it plans. */
  broken?: Broken | null;
}

/** What an editor sees of a measure they may not use: never its formula or filter. */
export interface RedactedMeasure {
  name: string;
  description: string;
  table: string;
  usable: false;
}

export type MeasureListItem = Measure | RedactedMeasure;

/** The list, and what the caller may change. */
export interface MeasureList {
  data: MeasureListItem[];
  /** Creating, changing and deleting: an editor holding `zeteo.measures.write`, on a source not archived. */
  can_edit: boolean;
  /** Replacing the editor list: a sources admin or the upload's owner, on a source not archived. */
  can_manage_editors: boolean;
}

export const isRedacted = (m: MeasureListItem): m is RedactedMeasure =>
  !("id" in m);

/** The body of a create, and of the preview's `measure`. */
export interface MeasureInput {
  name: string;
  description: string;
  table: string;
  formula: unknown;
  where?: unknown;
}

export interface MeasureEditor {
  type: "user" | "group";
  id: string;
  name: string | null;
  email?: string | null;
  added_at: string;
}

export interface PreviewResult {
  columns: { name: string; type: string }[];
  rows: unknown[][];
  truncated: boolean;
}
