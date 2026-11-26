import { markRounded, refuseRoundedNumbers } from "../row-rules/numbers.js";
import express, { type RequestHandler } from "express";

/**
 * `express.json` for a body that may carry a row rule (a grant's): each
 * number a double did not keep as written is refused under `row_rule`
 * (`refuseRoundedNumbers`), before the body is validated.
 */
export const ruleJson = (limit: string): RequestHandler[] => [
  express.json({
    limit,
    reviver: markRounded as Parameters<typeof JSON.parse>[1],
  }),
  (req, _res, next) => {
    refuseRoundedNumbers(req.body);
    next();
  },
];
