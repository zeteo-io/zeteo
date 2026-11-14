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
