import { DashboardNameSchema } from "../../schemas.js";
import { z } from "zod";

export const CopyDashboardSchema = z.strictObject({
  name: DashboardNameSchema,
});
