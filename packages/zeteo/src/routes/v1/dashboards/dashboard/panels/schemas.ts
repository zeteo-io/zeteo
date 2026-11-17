import type { PanelReplacement } from "../../../../../dashboards/service.js";
import type { PanelInput } from "../../../../../dashboards/service.js";
import { GRID_COLUMNS } from "../../../../../dashboards/layout.js";
import { chartSchema } from "../../../../../dashboards/chart.js";
import { IdSchema } from "../../../../../utils/idSchema.js";
import { noNul } from "../../../../../utils/text.js";
import { z } from "zod";

/** A panel's own title: 1 to 100 characters, trimmed. */
export const PanelTitleSchema = noNul(z.string().trim().min(1).max(100));

export const TimeColumnSchema = z.string().min(1).max(200);

/** The most rows tall a panel may be, and the lowest row it may start at. */
export const MAX_PANEL_HEIGHT = 50;
export const MAX_PANEL_ROW = 1000;

/** A panel's place on the 12-column grid; each part may be left out when the panel is added. */
export const PlaceFields = {
  x: z
    .int()
    .min(0)
    .max(GRID_COLUMNS - 1)
    .optional(),
  y: z.int().min(0).max(MAX_PANEL_ROW).optional(),
  w: z.int().min(1).max(GRID_COLUMNS).optional(),
  h: z.int().min(1).max(MAX_PANEL_HEIGHT).optional(),
};

type Place = { x?: number; y?: number; w?: number; h?: number };

/** The place's parts that cannot be judged one at a time: `x` and `y` go together, and the panel fits the grid. */
export const placeIssues = (p: Place, ctx: z.RefinementCtx) => {
  if ((p.x === undefined) !== (p.y === undefined)) {
    ctx.addIssue({
      code: "custom",
      message: "x and y go together",
      path: [p.x === undefined ? "x" : "y"],
    });
  }
  if (p.x !== undefined && p.w !== undefined && p.x + p.w > GRID_COLUMNS) {
    ctx.addIssue({
      code: "custom",
      message: `x + w is at most ${GRID_COLUMNS}`,
      path: ["w"],
    });
  }
};

const ownPanel = z.strictObject({
  kind: z.literal("own"),
  saved_query_id: IdSchema,
  chart: chartSchema,
  time_column: TimeColumnSchema.optional(),
  title: PanelTitleSchema.optional(),
  ...PlaceFields,
});

const linkedPanel = z.strictObject({
  kind: z.literal("linked"),
  saved_panel_id: IdSchema,
  title: PanelTitleSchema.optional(),
  ...PlaceFields,
});

/** A panel as the dashboard routes take it, own or linked, as the service takes it. */
export const PanelInputSchema = z
  .discriminatedUnion("kind", [ownPanel, linkedPanel])
  .superRefine(placeIssues)
  .transform((p): PanelInput => {
    const { x, y, w, h, title } = p;
    return p.kind === "own"
      ? {
          kind: "own",
          savedQueryId: p.saved_query_id,
          chart: p.chart,
          timeColumn: p.time_column,
          title,
          x,
          y,
          w,
          h,
        }
      : { kind: "linked", savedPanelId: p.saved_panel_id, title, x, y, w, h };
  });

/** A panel of a replacement list that keeps its row: its id and place, and optionally a new title, saved query, chart or time column. */
const existingPanel = z
  .strictObject({
    id: IdSchema,
    x: PlaceFields.x.unwrap(),
    y: PlaceFields.y.unwrap(),
    w: PlaceFields.w.unwrap(),
    h: PlaceFields.h.unwrap(),
    title: PanelTitleSchema.nullable().optional(),
    saved_query_id: IdSchema.optional(),
    chart: chartSchema.optional(),
    time_column: TimeColumnSchema.nullable().optional(),
  })
  .superRefine(placeIssues)
  .transform((p): PanelReplacement => ({
    id: p.id,
    x: p.x,
    y: p.y,
    w: p.w,
    h: p.h,
    title: p.title,
    savedQueryId: p.saved_query_id,
    chart: p.chart,
    timeColumn: p.time_column,
  }));

/** A replacement list's entry: an existing panel by `id`, else a new panel. */
export const ReplacementPanelSchema = z.union([
  existingPanel,
  PanelInputSchema,
]);
