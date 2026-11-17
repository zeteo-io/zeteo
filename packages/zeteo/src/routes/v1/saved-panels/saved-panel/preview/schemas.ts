import { TimeRangeSchema } from "../../../dashboards/schemas.js";
import { z } from "zod";

/** The time range to apply when the saved panel has a time column; none runs it unfiltered. */
export const PreviewSavedPanelSchema = z.strictObject({
  time_range: TimeRangeSchema.optional(),
});
