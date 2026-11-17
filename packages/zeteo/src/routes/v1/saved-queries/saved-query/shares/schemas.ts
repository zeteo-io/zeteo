import { IdSchema } from "../../../../../utils/idSchema.js";
import { z } from "zod";

/** The most principals one saved query is shared with in a replacement. */
export const MAX_SHARES = 100;

export const SharePrincipalSchema = z.strictObject({
  type: z.enum(["user", "group"]),
  id: IdSchema,
});

/** The whole share list; each principal once, the owner not among them (the service checks that). */
export const ReplaceSharesSchema = z.strictObject({
  principals: z
    .array(SharePrincipalSchema)
    .max(MAX_SHARES)
    .refine(
      (ps) => new Set(ps.map((p) => `${p.type}:${p.id}`)).size === ps.length,
      { message: "Each principal may appear only once" }
    ),
});
