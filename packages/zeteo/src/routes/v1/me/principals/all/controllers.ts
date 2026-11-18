import { ListAllPrincipalsQuerySchema } from "../../../principals/all/schemas.js";
import { listAllPrincipals } from "../../../../../principals/directory.js";
import { validateQuery } from "../../../../../utils/validateReq.js";
import { callerOf } from "../../../../../middleware/auth.js";
import type { Request, Response } from "express";

/** Everyone the caller may share with: human users, and groups that are global or the caller's organization's. */
export const listAllMyPrincipals = async (req: Request, res: Response) => {
  validateQuery(ListAllPrincipalsQuerySchema, req);
  const { principals, truncated } = await listAllPrincipals({
    organizationId: callerOf(req).organizationId,
  });
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ data: principals, truncated });
};
