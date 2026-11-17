import type { QueryPlan } from "../adapters/types.js";
import { createHash } from "crypto";

/** `value` as JSON with every object's keys sorted, so equal values give equal text. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) => {
    if (typeof inner === "bigint") return inner.toString();
    if (inner === null || typeof inner !== "object" || Array.isArray(inner)) {
      return inner;
    }
    return Object.fromEntries(
      Object.keys(inner)
        .sort()
        .map((k) => [k, (inner as Record<string, unknown>)[k]])
    );
  });

const sha256 = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

/**
 * The identity of a dashboard run: one source, one plan, one row cap. Runs
 * with the same fingerprint share one execution and one cache entry. It holds
 * relative dates resolved against the dashboard's `now`, so it is not the
 * identity a run is recorded under (`recordIdentityOf` is).
 *
 * The plan stands in for the compiled SQL, and that is why a cache entry may
 * be shared between viewers: the planner builds a plan only from the viewer's
 * visible catalogue (granted tables and columns, relations whose keys are all
 * granted) and the query's bound values, and every reference in it is checked
 * against their grants. Equal plans therefore compile to the same SQL with the
 * same parameters, over data both viewers may read. A future row filter must
 * be part of the plan, or this stops being true.
 */
export const fingerprintOf = (
  sourceId: string,
  plan: QueryPlan,
  rows: { limit: number; offset: number }
): string => sha256(canonical({ sourceId, plan, rows }));

/**
 * The identity a dashboard run of a saved query is recorded under, once per
 * viewer and window: the source, the saved query, the body as the panel
 * wrote it (relative dates and the dashboard's time range unresolved) and the
 * row cap. Unlike the plan's fingerprint it does not change as `now` moves,
 * so a `last_24_hours` panel on a wall display is not a new query each minute.
 */
export const recordIdentityOf = (
  sourceId: string,
  savedQueryId: string,
  body: unknown,
  maxRows: number
): string => sha256(canonical({ sourceId, savedQueryId, body, maxRows }));

/**
 * The identity a refused dashboard run of a saved query is recorded under:
 * there is no plan to fingerprint, so one per saved query.
 */
export const refusalFingerprintOf = (savedQueryId: string): string =>
  sha256(canonical({ savedQueryId, outcome: "refused" }));
