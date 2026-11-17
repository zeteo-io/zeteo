import type { Principal as DbPrincipal } from "../utils/db/grants.js";

/** A user or group something is shared with. */
export type SharePrincipal = DbPrincipal;

const keyOf = (p: SharePrincipal) => `${p.type}:${p.id}`;

/**
 * What replacing a share list with `wanted` changes, given the `existing`
 * principals: who is added and who removed, in the order each list has them.
 * Shared by the share tables of saved queries, saved panels and dashboards.
 */
export const diffPrincipals = (
  existing: readonly SharePrincipal[],
  wanted: readonly SharePrincipal[]
): { added: SharePrincipal[]; removed: SharePrincipal[] } => {
  const want = new Map(wanted.map((p) => [keyOf(p), p]));
  const have = new Map(existing.map((p) => [keyOf(p), p]));
  return {
    added: [...want].filter(([k]) => !have.has(k)).map(([, p]) => p),
    removed: [...have].filter(([k]) => !want.has(k)).map(([, p]) => p),
  };
};
