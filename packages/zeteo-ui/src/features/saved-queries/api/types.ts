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
  warnings: ShareWarning[];
}

export interface TransferResult {
  data: SavedQuery;
  warning?: { accessible: false };
}
