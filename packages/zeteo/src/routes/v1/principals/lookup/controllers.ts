import { lookupPrincipals } from "../../../../principals/directory.js";
import { validateBody } from "../../../../utils/validateReq.js";
import { LookupPrincipalsBodySchema } from "./schemas.js";
import type { Request, Response } from "express";

export const lookupPrincipalsHandler = async (req: Request, res: Response) => {
  const body = validateBody(LookupPrincipalsBodySchema, req);
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ data: await lookupPrincipals(body.principals) });
};
