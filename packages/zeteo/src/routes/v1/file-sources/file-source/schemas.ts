import { IdSchema } from "../../../../utils/idSchema.js";
import { noNul } from "../../../../utils/text.js";
import { z } from "zod";

export const FileSourceParamsSchema = z.object({ sourceId: IdSchema });

export const UpdateFileSourceSchema = z.strictObject({
  name: noNul(z.string().trim().min(1).max(255)),
});
