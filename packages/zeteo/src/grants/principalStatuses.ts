import type { PrincipalType } from "../../prisma/generated/client/index.js";
import { principalStatus, type PrincipalStatus } from "./principals.js";
import { logger } from "../utils/logger.js";

/** Looks up a principal's status by type and id. */
export interface PrincipalStatuses {
  get(type: PrincipalType, id: string): PrincipalStatus;
}

/**
 * The status of each distinct principal, looked up once, concurrently, and
 * never inside a transaction (outside test mode each lookup is a call to
 * tereo). A lookup that fails is logged and shown as `unknown`: the grant
 * itself was read or changed, and a tereo outage must not hide that.
 */
export const principalStatuses = async (
  principals: Array<{ principalType: PrincipalType; principalId: string }>
): Promise<PrincipalStatuses> => {
  const key = (type: PrincipalType, id: string) => `${type}:${id}`;
  const distinct = new Map(
    principals.map((p) => [key(p.principalType, p.principalId), p])
  );
  const found = new Map<string, PrincipalStatus>();
  await Promise.all(
    [...distinct].map(async ([k, p]) => {
      try {
        found.set(k, await principalStatus(p.principalType, p.principalId));
      } catch (err) {
        logger.warn(
          { err, principal_type: p.principalType, principal_id: p.principalId },
          "principal status unavailable; showing unknown"
        );
        found.set(k, "unknown");
      }
    })
  );
  return { get: (type, id) => found.get(key(type, id)) ?? "unknown" };
};
