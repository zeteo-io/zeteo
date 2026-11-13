import { IdSchema } from "../../../utils/idSchema.js";
import { z } from "zod";

export const ListRunsQuerySchema = z.strictObject({
  user_id: IdSchema.optional(),
  source_id: IdSchema.optional(),
  outcome: z.enum(["ok", "refused", "failed", "timeout"]).optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** A list cursor's values: the last run's id (ids are time-ordered). */
export const RunCursorSchema = z.tuple([IdSchema]);
