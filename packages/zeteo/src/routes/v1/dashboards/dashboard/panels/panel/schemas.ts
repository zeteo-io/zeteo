import { PanelTitleSchema, PlaceFields, TimeColumnSchema } from "../schemas.js";
import { chartSchema } from "../../../../../../dashboards/chart.js";
import { IdSchema } from "../../../../../../utils/idSchema.js";
import { z } from "zod";

export const PanelParamsSchema = z.object({
  dashboardId: IdSchema,
  panelId: IdSchema,
});

/** What of a panel may change: its title, place, saved query, chart and time column. Whether they fit is for the service to judge. */
export const UpdatePanelSchema = z
  .strictObject({
    title: PanelTitleSchema.nullable().optional(),
    saved_query_id: IdSchema.optional(),
    chart: chartSchema.optional(),
    time_column: TimeColumnSchema.nullable().optional(),
    ...PlaceFields,
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "Give at least one field to change",
  })
  .refine(
    (body) =>
      body.x === undefined || body.w === undefined || body.x + body.w <= 12,
    { message: "x + w is at most 12", path: ["w"] }
  );
