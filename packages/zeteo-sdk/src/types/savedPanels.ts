import type { ListOptions } from "./common.js";
import type {
  ChartProblem,
  ChartSettings,
  PanelState,
  TimeRangeKey,
} from "./dashboards.js";

/**
 * A chart on a saved query that dashboards can link. `chart`, `time_column`
 * and `saved_query_id` are present only when `state` is `ok` (never null);
 * nothing of why a viewer cannot run it is carried.
 */
export interface SavedPanel {
  id: string;
  name: string;
  description: string;
  owner: { id: string; name: string | null };
  state: PanelState;
  message?: string;
  chart?: ChartSettings;
  time_column?: string;
  saved_query_id?: string;
  problems?: ChartProblem[];
  /** For its owner and `zeteo.dashboards.read`. */
  used_by?: { dashboards: number };
  created_at: string;
  updated_at: string;
  /** When it was first shared with the viewer; present only when it was. */
  shared_at?: string;
  /** Present only when the viewer may see the share list. */
  share_count?: number;
}

export interface ListSavedPanelsOptions extends ListOptions {
  /** `mine` (the default), `shared` with the caller, or `all` (`zeteo.dashboards.read`). */
  scope?: "mine" | "shared" | "all";
  /** 1 to 100 characters of the name, case-insensitively. */
  q?: string;
  /** `scope: "all"` only. */
  owner_id?: string;
}

export interface CreateSavedPanelRequest {
  /** 1 to 100 characters, trimmed; unique per owner, whatever the case. */
  name: string;
  /** At most 2000 characters; the API's default is `""`. */
  description?: string;
  saved_query_id: string;
  chart: ChartSettings;
  /** A date or timestamp column of the saved query's result. */
  time_column?: string;
}

/** At least one field. */
export interface UpdateSavedPanelRequest {
  name?: string;
  description?: string;
  saved_query_id?: string;
  chart?: ChartSettings;
  /** Null removes the time column. */
  time_column?: string | null;
}

export interface CopySavedPanelRequest {
  name: string;
}

/** What `dashboards.savePanel` takes: the new saved panel's name and description. */
export interface SaveAsSavedPanelRequest {
  name: string;
  description?: string;
}

export interface PreviewSavedPanelRequest {
  /** Applied to the saved panel's time column when it has one; none runs it unfiltered. */
  time_range?: TimeRangeKey;
}
