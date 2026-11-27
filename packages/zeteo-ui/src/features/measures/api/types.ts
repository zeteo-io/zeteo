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
  /** One value over the whole table, ignoring a query's filters; usable from any table. */
  fixed: boolean;
  /** A column path from the home table through to-one relations; null for none. */
  date_column: string | null;
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
  fixed?: boolean;
  date_column?: string | null;
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
  /** A row rule of the caller's limits the rows of a table the preview reads. */
  rows_limited?: boolean;
}

/** A metric the caller sees in full (the server's `metricView`). */
export interface Metric {
  id: string;
  name: string;
  description: string;
  formula: unknown;
  created_at: string;
  updated_at: string;
  usable: boolean;
  /** Editors and admins only. */
  used_by?: UsedBy;
  broken?: Broken | null;
}

/** A metric an editor may not use: never its formula. */
export interface RedactedMetric {
  name: string;
  description: string;
  usable: false;
}

export type MetricListItem = Metric | RedactedMetric;

export interface MetricList {
  data: MetricListItem[];
  can_edit: boolean;
  can_manage_editors: boolean;
}

export const isRedactedMetric = (m: MetricListItem): m is RedactedMetric =>
  !("id" in m);

export interface MetricInput {
  name: string;
  description: string;
  formula: unknown;
}

export interface MetricPreviewBody {
  metric: MetricInput;
  bucket?: "month";
  range?: { gte?: { date: string }; lt?: { date: string } };
}
