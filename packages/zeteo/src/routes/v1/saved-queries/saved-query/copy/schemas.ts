import { SavedQueryNameSchema } from "../../schemas.js";
import { z } from "zod";

export const CopySavedQuerySchema = z.strictObject({
  name: SavedQueryNameSchema,
});
