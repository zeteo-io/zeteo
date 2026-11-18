import { IdSchema } from "../../../../utils/idSchema.js";
import { z } from "zod";

export const UploadParamsSchema = z.object({ uploadId: IdSchema });
