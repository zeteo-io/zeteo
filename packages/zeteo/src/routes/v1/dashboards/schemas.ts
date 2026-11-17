import { TIME_RANGE_KEYS } from "../../../dashboards/timeRange.js";
import { MAX_PANELS } from "../../../dashboards/layout.js";
import { IdSchema } from "../../../utils/idSchema.js";
import { noNul } from "../../../utils/text.js";
import env from "../../../env.js";
import { z } from "zod";
import {
  PanelInputSchema,
  ReplacementPanelSchema,
} from "./dashboard/panels/schemas.js";

/** Trimmed, 1 to 100 characters; unique per owner whatever the case (the database holds that). */
export const DashboardNameSchema = noNul(z.string().trim().min(1).max(100));

export const DashboardDescriptionSchema = noNul(z.string().max(2000));

/** The dashboard's default time range; null for none. */
export const TimeRangeSchema = z.enum(TIME_RANGE_KEYS);

/** Auto-refresh in seconds: at least the deploy's minimum; null for none. */
export const RefreshSecondsSchema = z
  .int()
  .min(env.DASHBOARD_MIN_REFRESH_SECONDS)
  .max(86400);

export const ThemeSchema = z.enum(["light", "dark", "auto"]);

export const PanelsSchema = z.array(PanelInputSchema).max(MAX_PANELS);

export const DashboardParamsSchema = z.object({ dashboardId: IdSchema });

/** `PATCH`'s list: each panel by id, or new. */
export const ReplacementPanelsSchema = z
  .array(ReplacementPanelSchema)
  .max(MAX_PANELS);

export const CreateDashboardSchema = z.strictObject({
  name: DashboardNameSchema,
  description: DashboardDescriptionSchema.default(""),
  time_range: TimeRangeSchema.nullable().optional(),
  refresh_seconds: RefreshSecondsSchema.nullable().optional(),
  theme: ThemeSchema.optional(),
  panels: PanelsSchema.optional(),
});

export const ListDashboardsQuerySchema = z
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

/** A list cursor's values: the dashboard's id (ids are time-ordered). */
export const DashboardCursorSchema = z.tuple([IdSchema]);
