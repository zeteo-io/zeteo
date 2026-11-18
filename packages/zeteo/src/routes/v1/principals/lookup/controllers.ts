import { grantPrincipalsOfOwnedSources } from "../../../../uploads/ownership.js";
import { validateBody } from "../../../../utils/validateReq.js";
import { LookupPrincipalsBodySchema } from "./schemas.js";
import { callerOf } from "../../../../middleware/auth.js";
import type { Request, Response } from "express";
import {
  lookupPrincipals,
  orphaned,
  type Principal,
  type PrincipalRef,
} from "../../../../principals/directory.js";

const keyOf = (ref: PrincipalRef) => `${ref.type}:${ref.id}`;

/**
 * For a caller let in only as an upload source owner: the principals holding a
 * grant on a source of theirs are looked up; any other id is answered as one
 * tereo does not know (`orphaned`), so nothing tells the two apart, and tereo
 * is not asked about it.
 */
const lookupAsOwner = async (
  userId: string,
  refs: PrincipalRef[]
): Promise<Principal[]> => {
  const allowed = await grantPrincipalsOfOwnedSources(userId);
  const distinct = [...new Map(refs.map((r) => [keyOf(r), r])).values()];
  const asked = distinct.filter((r) => allowed.has(keyOf(r)));
  const found = new Map(
    (asked.length > 0 ? await lookupPrincipals(asked) : []).map((p) => [
      keyOf(p),
      p,
    ])
  );
  return distinct.map((r) => found.get(keyOf(r)) ?? orphaned(r));
};

export const lookupPrincipalsHandler = async (req: Request, res: Response) => {
  const body = validateBody(LookupPrincipalsBodySchema, req);
  const data = res.locals.ownerLookup
    ? await lookupAsOwner(callerOf(req).userId, body.principals)
    : await lookupPrincipals(body.principals);
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ data });
};
