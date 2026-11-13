import { z } from "zod";

export const CatalogQuerySchema = z.strictObject({
  source: z.string().min(1).max(200).optional(),
});
