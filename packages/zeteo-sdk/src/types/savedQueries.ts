import type { ListOptions, PrincipalType } from "./common.js";
import type { Query } from "./query.js";

/**
 * A saved query as the viewer sees it. `source` and `query` are absent, not
 * null, unless the viewer may run it (`accessible`); a viewer who may read
 * sources sees `source` regardless.
 */
export interface SavedQuery {
  id: string;
  name: string;
  description: string;
  owner: { id: string; name: string | null };
  /** Whether the viewer may run it now, planned against what they are granted. */
  accessible: boolean;
  created_at: string;
  updated_at: string;
  /** When it was shared with the viewer; present only when it was. */
  shared_at?: string;
  /** Whether its owner offers it to dashboards, in the organization they are signed in to. */
  available_for_dashboards: boolean;
  /** The last run by anyone. */
  last_run_at: string | null;
  /** The viewer's own last run. */
  you_last_ran_at: string | null;
  source?: { id: string; slug: string };
  query?: Query;
  /** Present only when the viewer may see the share list. */
  share_count?: number;
  /** On a single read, for its owner and `zeteo.saved_queries.read`: what is built on it. */
  used_by?: { dashboards: number; saved_panels: number };
}

export interface ListSavedQueriesOptions extends ListOptions {
  /**
   * `mine` (the default), `shared` with the caller, `available` (offered to
   * dashboards in the caller's organization, not the caller's own), or `all`
   * (`zeteo.saved_queries.read`).
   */
  scope?: "mine" | "shared" | "available" | "all";
  /** 1 to 100 characters of the name, case-insensitively. */
  q?: string;
  /** `scope: "all"` only; also needs `zeteo.sources.read`. */
  source_id?: string;
  /** `scope: "all"` only. */
  owner_id?: string;
  /** `scope: "all"` only; goes with `shared_with_id`. */
  shared_with_type?: PrincipalType;
  /** `scope: "all"` only; goes with `shared_with_type`. */
  shared_with_id?: string;
}

export interface CreateSavedQueryRequest {
  /** 1 to 100 characters, trimmed; unique per owner, whatever the case. */
  name: string;
  /** At most 2000 characters; the API's default is `""`. */
  description?: string;
  query: Query;
}

/** At least one field. */
export interface UpdateSavedQueryRequest {
  name?: string;
  description?: string;
  query?: Query;
  /** Offers it to dashboards, or withdraws it. */
  available_for_dashboards?: boolean;
}

/** A dashboard or saved panel built on a saved query. */
export interface SavedQueryUse {
  type: "dashboard" | "saved_panel";
  id: string;
  name: string;
  owner: { id: string; name: string | null };
}

export interface CopySavedQueryRequest {
  name: string;
}

/** The paging a run or export may give in place of the stored `limit` and `offset`. */
export interface SavedQueryPaging {
  limit?: number;
  offset?: number;
}

export interface SharePrincipal {
  type: PrincipalType;
  id: string;
}

export interface SavedQueryShare {
  type: PrincipalType;
  id: string;
  /** Null when the directory could not name it. */
  name: string | null;
  /** Users only. */
  email?: string | null;
  shared_at: string;
}

export interface SavedQueryShares {
  data: SavedQueryShare[];
}

export interface ReplaceSharesResponse {
  data: SavedQueryShare[];
  /** Each user newly added who could not run the saved query. */
  warnings: { type: "user"; id: string; accessible: false }[];
}

export interface TransferSavedQueryRequest {
  user_id: string;
  /** The previous owner keeps a direct share; the API's default is true. */
  keep_access?: boolean;
}

export interface TransferSavedQueryResponse {
  data: SavedQuery;
  /** Present when the new owner could not run the saved query. */
  warning?: { accessible: false };
}
