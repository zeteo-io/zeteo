import { ExportConcurrencySchema, QueryConcurrencySchema } from "../schemas.js";
import { IdSchema } from "../../../../utils/idSchema.js";
import { z } from "zod";

export const PrincipalLimitParamsSchema = z.object({
  principalLimitId: IdSchema,
});

/** Either limit or both; null clears one. The principal never changes. */
export const UpdatePrincipalLimitSchema = z
  .strictObject({
    query_concurrency: QueryConcurrencySchema.nullable().optional(),
    export_concurrency: ExportConcurrencySchema.nullable().optional(),
  })
  .refine(
    (body) =>
      body.query_concurrency !== undefined ||
      body.export_concurrency !== undefined,
    { message: "Give query_concurrency, export_concurrency or both" }
  );
