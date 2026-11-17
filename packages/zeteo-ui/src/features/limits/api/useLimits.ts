import type { LimitFilters, PrincipalLimit } from "./types";
import { useCursorList } from "@/lib/api";

/** Limits in creation order, narrowed by the filters. */
export const useLimits = (filters: LimitFilters = {}) =>
  useCursorList<PrincipalLimit>(["principal-limits"], "/v1/principal-limits", {
    ...filters,
  });
