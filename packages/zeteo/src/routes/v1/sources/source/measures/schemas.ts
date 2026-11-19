import { noNul } from "../../../../../utils/text.js";
import { z } from "zod";
import {
  MEASURE_NAME_SCHEMA,
  measureFormulaSchema,
  measureWhereSchema,
} from "../../../../../adapters/sql/language.js";

/** At most this many characters in a measure's description. */
export const MAX_MEASURE_DESCRIPTION = 2000;

/** A measure's fields as a request gives them; the planner checks them against the editor's catalogue. */
export const MeasureFieldsShape = {
  name: MEASURE_NAME_SCHEMA,
  description: noNul(z.string().trim().min(1).max(MAX_MEASURE_DESCRIPTION)),
  table: noNul(z.string().min(1).max(256)),
  formula: measureFormulaSchema,
  where: measureWhereSchema.nullable(),
  fixed: z.boolean(),
  /** A column path from the home table, through to-one relations; null for none. */
  date_column: noNul(z.string().min(1).max(256)).nullable(),
};

export const CreateMeasureSchema = z.strictObject({
  ...MeasureFieldsShape,
  where: MeasureFieldsShape.where.optional(),
  fixed: MeasureFieldsShape.fixed.optional(),
  date_column: MeasureFieldsShape.date_column.optional(),
});
