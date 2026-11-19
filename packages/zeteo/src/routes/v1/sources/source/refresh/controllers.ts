import { refreshSource as refresh } from "../../../../../catalog/refresh.js";
import { validateParams } from "../../../../../utils/validateReq.js";
import { isUploadSource } from "../../../../../sources/types.js";
import { callerOf } from "../../../../../middleware/auth.js";
import { syncNow } from "../../../../../uploads/sync.js";
import { db } from "../../../../../utils/db/index.js";
import { SourceParamsSchema } from "../schemas.js";
import type { Request, Response } from "express";

export const refreshSource = async (req: Request, res: Response) => {
  const { sourceId } = validateParams(SourceParamsSchema, req);
  const { userId } = callerOf(req);
  const row = await db.sources.findById(sourceId);
  res
    .status(200)
    .json(
      row && isUploadSource(row) && (await db.sources.hasSheetsTables(row.id))
        ? await syncNow(sourceId, userId)
        : await refresh(sourceId, userId)
    );
};
