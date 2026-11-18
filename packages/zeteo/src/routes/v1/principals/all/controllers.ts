import { listAllPrincipals } from "../../../../principals/directory.js";
import { validateQuery } from "../../../../utils/validateReq.js";
import { ListAllPrincipalsQuerySchema } from "./schemas.js";
import type { Request, Response } from "express";

/** Every user and group, for an admin's filters. */
export const listAllPrincipalsHandler = async (req: Request, res: Response) => {
  validateQuery(ListAllPrincipalsQuerySchema, req);
  const { principals, truncated } = await listAllPrincipals();
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ data: principals, truncated });
};
