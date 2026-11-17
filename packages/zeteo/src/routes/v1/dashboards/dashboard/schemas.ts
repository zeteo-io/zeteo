import { z } from "zod";
import {
  DashboardDescriptionSchema,
  DashboardNameSchema,
  ReplacementPanelsSchema,
  RefreshSecondsSchema,
  ThemeSchema,
  TimeRangeSchema,
} from "../schemas.js";

export { DashboardParamsSchema } from "../schemas.js";

export const UpdateDashboardSchema = z
  .strictObject({
    name: DashboardNameSchema.optional(),
    description: DashboardDescriptionSchema.optional(),
    time_range: TimeRangeSchema.nullable().optional(),
    refresh_seconds: RefreshSecondsSchema.nullable().optional(),
    theme: ThemeSchema.optional(),
    panels: ReplacementPanelsSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message:
      "Give at least one of name, description, time_range, refresh_seconds, theme and panels",
  });
