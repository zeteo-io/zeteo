import type { ListOptions, PrincipalType } from "./common.js";
import type { PrincipalStatus } from "./grants.js";

export interface PrincipalLimit {
  id: string;
  principal_type: PrincipalType;
  principal_id: string;
  principal_status: PrincipalStatus;
  query_concurrency: number | null;
  export_concurrency: number | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** At least one of `query_concurrency` and `export_concurrency`. */
export interface CreatePrincipalLimitRequest {
  principal_type: PrincipalType;
  principal_id: string;
  /** 1 to 100. */
  query_concurrency?: number;
  /** 1 to 10. */
  export_concurrency?: number;
}

/** At least one field; `null` clears a limit. */
export interface UpdatePrincipalLimitRequest {
  query_concurrency?: number | null;
  export_concurrency?: number | null;
}

export interface ListPrincipalLimitsOptions extends ListOptions {
  principal_type?: PrincipalType;
  principal_id?: string;
}
