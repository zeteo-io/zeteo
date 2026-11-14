import { searchPrincipals } from "../../../principals/directory.js";
import { validateQuery } from "../../../utils/validateReq.js";
import { SearchPrincipalsQuerySchema } from "./schemas.js";
import type { Request, Response } from "express";

export const searchPrincipalsHandler = async (req: Request, res: Response) => {
  const query = validateQuery(SearchPrincipalsQuerySchema, req);
  const data = await searchPrincipals(query.type, query.q, query.limit);
  res.status(200).json({ data });
};
