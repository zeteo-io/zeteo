import { MAX_MEASURE_DESCRIPTION } from "../measures/schemas.js";
import { noNul } from "../../../../../utils/text.js";
import { z } from "zod";
import {
  MEASURE_NAME_SCHEMA,
  measureFormulaSchema,
} from "../../../../../adapters/sql/language.js";

/** A metric's fields as a request gives them; the service checks the formula against the editor's catalogue. */
export const MetricFieldsShape = {
  name: MEASURE_NAME_SCHEMA,
  description: noNul(z.string().trim().min(1).max(MAX_MEASURE_DESCRIPTION)),
  formula: measureFormulaSchema,
};

export const CreateMetricSchema = z.strictObject(MetricFieldsShape);
