import { IdSchema } from "../../../../../../utils/idSchema.js";
import { z } from "zod";
import {
  ColumnCorrectionSchema,
  HeaderRowSchema,
  TableKeySchema,
} from "../../../schemas.js";

export const TableParamsSchema = z.object({
  sourceId: IdSchema,
  tableId: IdSchema,
});

export const ReuploadTableSchema = z.strictObject({
  staging_id: IdSchema,
  key: TableKeySchema,
  header_row: HeaderRowSchema.optional(),
  columns: z.array(ColumnCorrectionSchema).max(1600).optional(),
});
