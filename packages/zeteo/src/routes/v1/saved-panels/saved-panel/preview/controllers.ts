import { savedPanelToPreview } from "../../../../../saved-panels/service.js";
import { serveQuery } from "../../../../../utils/serveQuery.js";
import { callerOf } from "../../../../../middleware/auth.js";
import { runQuery } from "../../../../../engine/index.js";
import { SavedPanelParamsSchema } from "../schemas.js";
import { PreviewSavedPanelSchema } from "./schemas.js";
import type { Request, Response } from "express";
import {
  validateBody,
  validateParams,
} from "../../../../../utils/validateReq.js";

export const previewSavedPanel = async (req: Request, res: Response) => {
  const { savedPanelId } = validateParams(SavedPanelParamsSchema, req);
  const { time_range: timeRange } = validateBody(PreviewSavedPanelSchema, req);
  const caller = callerOf(req);
  const { body, savedQuery } = await savedPanelToPreview(
    caller,
    savedPanelId,
    timeRange ?? null
  );
  await serveQuery(req, res, (signal) =>
    runQuery({ caller, entryPoint: "api", body, savedQuery, signal })
  );
};
