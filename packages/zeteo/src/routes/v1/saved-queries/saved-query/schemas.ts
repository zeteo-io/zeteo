import { MAX_OFFSET } from "../../../../adapters/sql/language.js";
import { IdSchema } from "../../../../utils/idSchema.js";
import { z } from "zod";
import {
  SavedQueryBodySchema,
  SavedQueryDescriptionSchema,
  SavedQueryNameSchema,
} from "../schemas.js";

export const SavedQueryParamsSchema = z.object({ savedQueryId: IdSchema });

export const UpdateSavedQuerySchema = z
  .strictObject({
    name: SavedQueryNameSchema.optional(),
    description: SavedQueryDescriptionSchema.optional(),
    query: SavedQueryBodySchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "Give at least one of name, description and query",
  });

/**
 * The paging a run or export of a saved query may give, replacing the stored
 * `limit` and `offset`. Bounded as the query language bounds them, so an
 * out-of-range value is this 400, never a refusal of the saved query. No body
 * runs it as stored.
 */
export const SavedQueryPagingFields = {
  limit: z.int().min(1).optional(),
  offset: z.int().min(0).max(MAX_OFFSET).optional(),
};

export const SavedQueryPagingSchema = z
  .strictObject(SavedQueryPagingFields)
  .default({});
