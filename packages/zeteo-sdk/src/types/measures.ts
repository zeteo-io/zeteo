import type { CalcExpr, Filter, QueryResult } from "./query.js";
import type { PrincipalType } from "./common.js";

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
}

/** At least one field; `where: null` removes the filter. */
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
}

/** A draft measure, not saved, and the optional date bucket its value is grouped by. */
export interface PreviewMeasureRequest {
  measure: MeasureInput;
  bucket?: {
    unit:
      | "day"
      | "week"
      | "month"
      | "quarter"
      | "year"
      | "fiscal_quarter"
      | "fiscal_year";
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
