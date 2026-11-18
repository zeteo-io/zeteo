import { IdSchema } from "../../../../utils/idSchema.js";
import { noNul } from "../../../../utils/text.js";
import { z } from "zod";

/** A spreadsheet's link or id, or an existing Sheets source whose spreadsheet to read again. */
export const PostLinkBodySchema = z.union([
  z.object({ url: noNul(z.string().min(1).max(2048)) }).strict(),
  z.object({ source_id: IdSchema }).strict(),
]);
