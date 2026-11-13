import { z } from "zod";

export const ExportQuerySchema = z.strictObject({
  format: z.enum(["ndjson", "csv"]).default("ndjson"),
});
