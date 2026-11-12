import { randomUUID } from "crypto";

/**
 * A token as the SDK's test mode reads it: the user id, then `|` separated
 * fields. A token without permissions has no `perms` field, which test mode
 * reads as none.
 */
export const tokenFor = (o: {
  permissions: string[];
  userId?: string;
}): string =>
  `test-token-${o.userId ?? randomUUID()}${
    o.permissions.length ? `|perms=${o.permissions.join(",")}` : ""
  }`;
