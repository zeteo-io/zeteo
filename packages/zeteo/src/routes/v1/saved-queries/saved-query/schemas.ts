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
