import { IdSchema } from "../../../../../utils/idSchema.js";
import { z } from "zod";

export const TransferSavedPanelSchema = z.strictObject({
  user_id: IdSchema,
  keep_access: z.boolean().default(true),
});
