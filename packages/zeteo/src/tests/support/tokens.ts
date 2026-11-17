import { randomUUID } from "crypto";

/**
 * A token as the SDK's test mode reads it: the user id, then `|` separated
 * fields. A token without permissions has no `perms` field, which test mode
 * reads as none; without `client` it is issued to `test-client`; with `org`
 * it is signed in to that organization.
 */
export const tokenFor = (o: {
  permissions: string[];
  userId?: string;
  client?: string;
  org?: string;
}): string =>
  `test-token-${o.userId ?? randomUUID()}${o.org ? `|org=${o.org}` : ""}${
    o.client ? `|client=${o.client}` : ""
  }${o.permissions.length ? `|perms=${o.permissions.join(",")}` : ""}`;
