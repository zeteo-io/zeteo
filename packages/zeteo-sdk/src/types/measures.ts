import type { PrincipalType } from "./common.js";
import type {
  BucketUnit,
  CalcExpr,
  Filter,
  MetricRange,
  QueryResult,
} from "./query.js";

/**
 * What a measure needs to be saved. `formula` is group-level: every column it
 * reads sits inside an aggregate, or comes from other measures of the same
 * table (`{ measure: name }`).
 */
export interface MeasureInput {
  /** `^[a-z][a-z0-9_]{0,62}$`; unique per source across its tables. */
  name: string;
  /** 1 to 2,000 characters, trimmed. Written for people and Claude: what it is, when to use it and when not to. */
  description: string;
  /** The home table's query name, as the editor's catalogue names it. */
  table: string;
  formula: CalcExpr;
  /** Applies to every aggregate in the formula, those of the measures it uses included. */
  where?: Filter | null;
  /** One value that ignores a query's filters and grouping; default false. See `Measure.fixed`. */
  fixed?: boolean;
  /** A date or timestamp column path from the home table, through to-one relations: what a metric query's `bucket` and `range` apply to. Null for none. */
  date_column?: string | null;
}

/** At least one field; `where: null` removes the filter and `date_column: null` the date column. */
export type UpdateMeasureRequest = Partial<MeasureInput>;

/** Why a measure does not plan against its source's whole catalogue. */
export interface MeasureBroken {
  /** A query error code, such as `missing_in_source`. */
  code: string;
  message: string;
}

export interface MeasureUsedBy {
  saved_queries: number;
  panels: number;
}

/** A measure in full. */
export interface Measure {
  id: string;
  name: string;
  description: string;
  table: string;
  formula: CalcExpr;
  where: Filter | null;
  /**
   * A fixed measure is one value that ignores the query's filters and
   * grouping: a comparison value (`{ measure: name }`) or anywhere in an
   * expression, and in a metric query it reads no periods.
   */
  fixed: boolean;
  /** What a metric query's `bucket` and `range` apply to; null for none (`measure_has_no_date`). */
  date_column: string | null;
  created_at: string;
  updated_at: string;
  /** Whether it plans against the caller's own visible catalogue. */
  usable: boolean;
  /** For measure editors and those who see every measure. */
  used_by?: MeasureUsedBy;
  /** For those who see every measure; null when it plans cleanly. */
  broken?: MeasureBroken | null;
}

/**
 * A measure an editor cannot fully see: never its formula or filter, which
 * would name columns and values they are not granted. It has no `id`.
 */
export interface RedactedMeasure {
  name: string;
  description: string;
  table: string;
  usable: false;
}

export interface ListMeasuresResponse {
  data: (Measure | RedactedMeasure)[];
  /** Whether the caller may create, change and delete measures now: `zeteo.measures.write`, an editor, and the source not archived. */
  can_edit: boolean;
  /** Whether the caller may replace the editor list now: `zeteo.sources.write` or the upload's owner, and the source not archived. */
  can_manage_editors: boolean;
}

/** A draft measure, not saved, and the optional date bucket its value is grouped by. */
export interface PreviewMeasureRequest {
  measure: MeasureInput;
  bucket?: {
    unit: BucketUnit;
    /** A date or timestamp column of the home table. */
    column: string;
  };
}

/** A preview answers as a query does. */
export type PreviewMeasureResponse = QueryResult;

export interface MeasureEditor {
  type: PrincipalType;
  id: string;
  /** Null when the directory could not name it. */
  name: string | null;
  /** Users only. */
  email?: string | null;
  added_at: string;
}

export interface MeasureEditors {
  data: MeasureEditor[];
}

/**
 * What a metric needs to be saved: a formula over measures of any tables of
 * the source. Its leaves are numbers and `{ measure: name }` (at least one),
 * combined only by `add`, `sub`, `mul`, `div`, `abs`, `round` and the calendar
 * functions over date literals. A name is unique across measures and metrics.
 */
export interface MetricInput {
  /** `^[a-z][a-z0-9_]{0,62}$`. */
  name: string;
  /** 1 to 2,000 characters, trimmed. */
  description: string;
  formula: CalcExpr;
}

/** At least one field. */
export type UpdateMetricRequest = Partial<MetricInput>;

/** A metric in full. */
export interface Metric {
  id: string;
  name: string;
  description: string;
  formula: CalcExpr;
  created_at: string;
  updated_at: string;
  /** Whether every measure it uses is in the caller's own visible catalogue. */
  usable: boolean;
  /** For measure editors and those who see every metric. */
  used_by?: MeasureUsedBy;
  /** For those who see every metric; null when it plans cleanly. */
  broken?: MeasureBroken | null;
}

/**
 * A metric an editor cannot fully see, because a measure it uses is not
 * theirs: never its formula. It has no `id`.
 */
export interface RedactedMetric {
  name: string;
  description: string;
  usable: false;
}

export interface ListMetricsResponse {
  data: (Metric | RedactedMetric)[];
  /** Whether the caller may create, change and delete metrics now. */
  can_edit: boolean;
  /** Whether the caller may replace the editor list now. */
  can_manage_editors: boolean;
}

/** A draft metric, not saved, and the optional bucket and range of the metric query it runs in. */
export interface PreviewMetricRequest {
  metric: MetricInput;
  bucket?: BucketUnit;
  range?: MetricRange;
}
