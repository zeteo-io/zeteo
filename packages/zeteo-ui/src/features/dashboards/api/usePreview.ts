import { toApiError, useZeteoApi, type ApiError } from "@/lib/api";
import type { RunResult, TimeRangeKey } from "./types";
import { useQuery } from "@tanstack/react-query";

/** What a panel's editor previews: a saved query as it is, or a saved panel. */
export type PreviewTarget =
  | { kind: "saved_query"; id: string }
  | { kind: "saved_panel"; id: string; timeRange?: TimeRangeKey };

/** Runs the target as the caller (recorded like any run) for the editor's live preview. */
export const usePreview = (target: PreviewTarget | null) => {
  const api = useZeteoApi();
  return useQuery<RunResult, ApiError>({
    queryKey: ["preview", target],
    enabled: target !== null,
    retry: false,
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
      const t = target!;
      try {
        return (
          await api.post<RunResult>(
            t.kind === "saved_query"
              ? `/v1/saved-queries/${t.id}/run`
              : `/v1/saved-panels/${t.id}/preview`,
            t.kind === "saved_panel" && t.timeRange
              ? { time_range: t.timeRange }
              : {},
            { signal }
          )
        ).data;
      } catch (err) {
        throw toApiError(err);
      }
    },
  });
};
