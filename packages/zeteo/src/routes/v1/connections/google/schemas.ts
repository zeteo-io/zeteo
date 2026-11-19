import { z } from "zod";

/** A service-account key as the JSON object, or as the text of the downloaded file. */
export const PutGoogleConnectionSchema = z.strictObject({
  service_account_key: z.union([z.string(), z.record(z.string(), z.unknown())]),
});
