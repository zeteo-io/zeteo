import type { Run, RunFilters } from "./types";
import { useCursorList } from "@/lib/api";

/** Runs as the API returns them, newest first, narrowed by the filters. */
export const useRuns = (filters: RunFilters = {}) =>
  useCursorList<Run>(["runs"], "/v1/runs", { ...filters });
