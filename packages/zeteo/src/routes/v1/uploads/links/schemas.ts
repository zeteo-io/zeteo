import { IdSchema } from "../../../../utils/idSchema.js";
import { noNul } from "../../../../utils/text.js";
import { z } from "zod";

const UrlSchema = noNul(z.string().min(1).max(2048));

/**
 * A spreadsheet's link or id; with `source_id`, the upload source its tabs
 * are to be added to.
 */
export const PostLinkBodySchema = z.union([
  z.object({ url: UrlSchema }).strict(),
  z.object({ source_id: IdSchema, url: UrlSchema }).strict(),
]);
