import { IdSchema } from "../../../../../../../../utils/idSchema.js";
import { noNul } from "../../../../../../../../utils/text.js";
import { z } from "zod";
import {
  ColumnNameSchema,
  FileColumnTypeSchema,
} from "../../../../../schemas.js";

export const ColumnParamsSchema = z.object({
  sourceId: IdSchema,
  tableId: IdSchema,
  columnId: IdSchema,
});

export const UpdateColumnSchema = z
  .strictObject({
    type: FileColumnTypeSchema.optional(),
    name: ColumnNameSchema.optional(),
    description: noNul(z.string().max(2000)).nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "Give at least one field to change",
  });
