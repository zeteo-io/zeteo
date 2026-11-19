import { mergedColumns } from "../../../../../../uploads/merged.js";
import { MergedColumnsQuerySchema } from "./schemas.js";
import { SourceParamsSchema } from "../../schemas.js";
import type { Request, Response } from "express";
import {
  validateParams,
  validateQuery,
} from "../../../../../../utils/validateReq.js";

/** The union of the members' columns and their suggested labels, for the merged table editor. */
export const getMergedColumns = async (req: Request, res: Response) => {
  const { sourceId } = validateParams(SourceParamsSchema, req);
  const { member } = validateQuery(MergedColumnsQuerySchema, req);
  res.status(200).json(await mergedColumns(sourceId, member));
};
