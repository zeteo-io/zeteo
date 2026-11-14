import { countSearch } from "../../../principals/searchRateLimit.js";
import { callerOf } from "../../../middleware/auth.js";
import type { RequestHandler } from "express";

/** Counts the search against the caller's minute; lookups do not use it. */
export const limitSearch: RequestHandler = (req, _res, next) => {
  countSearch(callerOf(req).userId).then(() => next(), next);
};
