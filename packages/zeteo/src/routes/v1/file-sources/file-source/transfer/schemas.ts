import { IdSchema } from "../../../../../utils/idSchema.js";
import { z } from "zod";

export const TransferFileSourceSchema = z.strictObject({
  user_id: IdSchema,
  keep_access: z.boolean().default(true),
});
