import { ListRunsQuerySchema } from "../../runs/schemas.js";

/** The caller's own runs: the admin list's filters without the other user and the source. */
export const ListMyRunsQuerySchema = ListRunsQuerySchema.omit({
  user_id: true,
  source_id: true,
});
