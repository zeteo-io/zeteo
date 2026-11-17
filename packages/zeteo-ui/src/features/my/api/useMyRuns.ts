import { useCursorList } from "@/lib/api";
import type { MyRun } from "./types";

/** The person's own runs, newest first; with an id, only their runs of that saved query. */
export const useMyRuns = (savedQueryId?: string) =>
  useCursorList<MyRun>(["me", "runs"], "/v1/me/runs", {
    saved_query_id: savedQueryId,
  });
