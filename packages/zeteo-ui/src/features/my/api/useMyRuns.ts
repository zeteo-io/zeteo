import { useCursorList } from "@/lib/api";
import type { MyRun } from "./types";

/** The person's own runs, newest first. */
export const useMyRuns = () =>
  useCursorList<MyRun>(["me", "runs"], "/v1/me/runs");
