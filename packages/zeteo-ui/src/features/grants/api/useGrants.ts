import type { Grant, GrantFilters } from "./types";
import { useCursorList } from "@/lib/api";

/** Grants in creation order, narrowed by the filters. */
export const useGrants = (filters: GrantFilters = {}) =>
  useCursorList<Grant>(["grants"], "/v1/grants", { ...filters });
