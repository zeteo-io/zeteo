import { IdSchema } from "../../../../../utils/idSchema.js";
import { TablesSchema } from "../../schemas.js";
import { z } from "zod";

export const AddTablesSchema = z.strictObject({
  staging_id: IdSchema,
  tables: TablesSchema,
});
