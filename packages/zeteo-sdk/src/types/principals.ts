import type { PrincipalType } from "./common.js";

export interface PrincipalRef {
  type: PrincipalType;
  id: string;
}

/** `inactive` is a deactivated user or archived group; `orphaned`, one tereo does not have. */
export type DirectoryPrincipalStatus = "active" | "inactive" | "orphaned";

export interface Principal {
  type: PrincipalType;
  id: string;
  /** Null when the principal is orphaned. */
  name: string | null;
  /** Users only; null when the user is orphaned. */
  email?: string | null;
  status: DirectoryPrincipalStatus;
}

/** The whole directory: every user and group, by name (one without a name last). */
export interface AllPrincipals {
  data: Principal[];
  /** True when there were more than 5000 users, or more than 5000 groups, and some are left out. */
  truncated: boolean;
}

export interface SearchPrincipalsOptions {
  type: PrincipalType;
  /** 2 to 100 characters the name (or a user's email) contains. */
  q: string;
  /** 1 to 25; the API's default is 10. */
  limit?: number;
}

export interface Me {
  id: string;
  type: "user" | "service";
  name: string | null;
  email: string | null;
  /** Held permissions starting with `zeteo.` (and a bare `admin`), sorted. */
  permissions: string[];
}
