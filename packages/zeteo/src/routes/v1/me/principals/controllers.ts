import { SearchPrincipalsQuerySchema } from "../../principals/schemas.js";
import { searchPrincipals } from "../../../../principals/directory.js";
import { validateQuery } from "../../../../utils/validateReq.js";
import { callerOf } from "../../../../middleware/auth.js";
import type { Request, Response } from "express";

/** The people search for sharing: users, and groups that are global or the caller's organization's. */
export const searchMyPrincipals = async (req: Request, res: Response) => {
  const query = validateQuery(SearchPrincipalsQuerySchema, req);
  const data = await searchPrincipals(query.type, query.q, query.limit, {
    organizationId: callerOf(req).organizationId,
  });
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ data });
};
