import { IdSchema } from "../../../../utils/idSchema.js";
import { SourceFieldsShape } from "../schemas.js";
import { z } from "zod";

export const SourceParamsSchema = z.object({ sourceId: IdSchema });

/** Any of the create fields but `slug` and `type`; `settings` replaces the whole object. */
export const UpdateSourceSchema = z
  .strictObject({
    name: SourceFieldsShape.name.optional(),
    settings: SourceFieldsShape.settings.optional(),
    schemas: SourceFieldsShape.schemas.optional(),
    allow_writable_login: SourceFieldsShape.allow_writable_login.optional(),
    timeout_ms: SourceFieldsShape.timeout_ms.optional(),
    row_cap: SourceFieldsShape.row_cap.optional(),
    export_enabled: SourceFieldsShape.export_enabled.optional(),
    export_row_cap: SourceFieldsShape.export_row_cap.optional(),
    query_concurrency: SourceFieldsShape.query_concurrency.optional(),
    export_concurrency: SourceFieldsShape.export_concurrency.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "Give at least one field to change",
  })
  .refine(
    (body) =>
      body.allow_writable_login === undefined || body.settings !== undefined,
    {
      path: ["allow_writable_login"],
      message: "allow_writable_login applies only together with settings",
    }
  );
