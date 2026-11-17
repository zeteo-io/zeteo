import { TimeColumnSchema } from "../dashboards/dashboard/panels/schemas.js";
import { chartSchema } from "../../../dashboards/chart.js";
import { IdSchema } from "../../../utils/idSchema.js";
import { noNul } from "../../../utils/text.js";
import { z } from "zod";
import {
  DashboardDescriptionSchema,
  DashboardNameSchema,
} from "../dashboards/schemas.js";

/** Trimmed, 1 to 100 characters; unique per owner whatever the case (the database holds that). */
export const SavedPanelNameSchema = DashboardNameSchema;

export const SavedPanelDescriptionSchema = DashboardDescriptionSchema;

export const SavedPanelParamsSchema = z.object({ savedPanelId: IdSchema });

export const CreateSavedPanelSchema = z.strictObject({
  name: SavedPanelNameSchema,
  description: SavedPanelDescriptionSchema.default(""),
  saved_query_id: IdSchema,
  chart: chartSchema,
  time_column: TimeColumnSchema.optional(),
});

export const ListSavedPanelsQuerySchema = z
  .strictObject({
    scope: z.enum(["mine", "shared", "all"]).default("mine"),
    q: noNul(z.string().min(1).max(100)).optional(),
    owner_id: IdSchema.optional(),
    cursor: z.string().max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .refine((q) => q.scope === "all" || !q.owner_id, {
    message: "owner_id applies to scope=all only",
  });

/** A list cursor's values: the saved panel's id (ids are time-ordered). */
export const SavedPanelCursorSchema = z.tuple([IdSchema]);
