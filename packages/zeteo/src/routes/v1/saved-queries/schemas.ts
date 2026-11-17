import { IdSchema } from "../../../utils/idSchema.js";
import { noNul } from "../../../utils/text.js";
import { z } from "zod";

/** Trimmed, 1 to 100 characters; unique per owner whatever the case (the database holds that). */
export const SavedQueryNameSchema = noNul(z.string().trim().min(1).max(100));

export const SavedQueryDescriptionSchema = noNul(z.string().max(2000));

/** The query as `POST /v1/query` takes it: an object. Its source's language checks the rest. */
export const SavedQueryBodySchema = z.record(z.string(), z.unknown());

export const CreateSavedQuerySchema = z.strictObject({
  name: SavedQueryNameSchema,
  description: SavedQueryDescriptionSchema.default(""),
  query: SavedQueryBodySchema,
});

export const ListSavedQueriesQuerySchema = z
  .strictObject({
    scope: z.enum(["mine", "shared", "all", "available"]).default("mine"),
    q: noNul(z.string().min(1).max(100)).optional(),
    source_id: IdSchema.optional(),
    owner_id: IdSchema.optional(),
    shared_with_type: z.enum(["user", "group"]).optional(),
    shared_with_id: IdSchema.optional(),
    cursor: z.string().max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .refine(
    (q) =>
      q.scope === "all" ||
      (!q.source_id && !q.owner_id && !q.shared_with_type && !q.shared_with_id),
    {
      message: "source_id, owner_id and shared_with_* apply to scope=all only",
    }
  )
  .refine((q) => (q.shared_with_type === undefined) === !q.shared_with_id, {
    message: "shared_with_type and shared_with_id go together",
    path: ["shared_with_id"],
  });

/** A list cursor's values: the saved query's id (ids are time-ordered). */
export const SavedQueryCursorSchema = z.tuple([IdSchema]);
