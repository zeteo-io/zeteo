import { deleteGrant, getGrant, replaceGrant } from "./controllers.js";
import { allowOwnerOr } from "../../../../middleware/uploadOwner.js";
import { sourceOfGrant } from "./middleware.js";
import express, { Router } from "express";
import {
  GRANTS_READ,
  GRANTS_WRITE,
} from "../../../../definitions/tereoDeclaration.js";

const grantRouter = Router({ mergeParams: true });

const json64k = express.json({ limit: "64kb" });

// An upload source's owner may read, change and remove grants on its tables.
grantRouter.get("/", allowOwnerOr(GRANTS_READ, sourceOfGrant), getGrant);
grantRouter.put(
  "/",
  allowOwnerOr(GRANTS_WRITE, sourceOfGrant),
  json64k,
  replaceGrant
);
grantRouter.delete("/", allowOwnerOr(GRANTS_WRITE, sourceOfGrant), deleteGrant);

export default grantRouter;
