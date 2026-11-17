// Field for field the saved-query views of the API. `source`, `query` and
// `shared_at` are left out (never null) when they do not apply.

export interface SavedQuery {
  id: string;
  name: string;
  description: string;
  owner: { id: string; name: string | null };
  /** False when the viewer cannot run it now; then no `source` or `query`. */
  accessible: boolean;
  created_at: string;
  updated_at: string;
  /** Only when it was shared with the viewer. */
  shared_at?: string;
  last_run_at: string | null;
  you_last_ran_at: string | null;
  /** Direct and group shares, on the admin list; absent until the server sends it. */
  share_count?: number;
  /** Whether its owner made it available for dashboards. */
  available_for_dashboards?: boolean;
  /** What uses it: on the single read, for its owner and admins. */
  used_by?: { dashboards: number; saved_panels: number };
  source?: { id: string; slug: string };
  query?: unknown;
}

export type SavedQueryScope = "mine" | "shared";

export interface CreateSavedQuery {
  name: string;
  description?: string;
  query: unknown;
}

export interface UpdateSavedQuery {
  name?: string;
  description?: string;
  available_for_dashboards?: boolean;
}

export interface ShareRef {
  type: "user" | "group";
  id: string;
}

export interface Share extends ShareRef {
  name: string | null;
  email?: string | null;
  shared_at: string;
}

export interface ShareWarning {
  type: "user";
  id: string;
  accessible: false;
}

export interface ReplaceSharesResult {
  data: Share[];
  /** A saved query's answer only. */
  warnings?: ShareWarning[];
}

/** A saved query's answer; a dashboard's or saved panel's is the object itself, with no `warning`. */
export interface TransferResult {
  data?: SavedQuery;
  warning?: { accessible: false };
}
