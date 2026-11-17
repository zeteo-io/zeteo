import { TimeColumnSchema } from "../../dashboards/dashboard/panels/schemas.js";
import { chartSchema } from "../../../../dashboards/chart.js";
import { IdSchema } from "../../../../utils/idSchema.js";
import { z } from "zod";
import {
  SavedPanelDescriptionSchema,
  SavedPanelNameSchema,
} from "../schemas.js";

export { SavedPanelParamsSchema } from "../schemas.js";

export const UpdateSavedPanelSchema = z
  .strictObject({
    name: SavedPanelNameSchema.optional(),
    description: SavedPanelDescriptionSchema.optional(),
    saved_query_id: IdSchema.optional(),
    chart: chartSchema.optional(),
    time_column: TimeColumnSchema.nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message:
      "Give at least one of name, description, saved_query_id, chart and time_column",
  });
