import { useLocation } from "react-router-dom";
import { useAuth } from "@tereo-io/react";
import { useState } from "react";

/** Where a source page's back link goes, and what it says. */
export interface SourceBack {
  href: string;
  label: string;
}

export const SOURCES_BACK: SourceBack = { href: "/sources", label: "Sources" };
export const MY_DATA_BACK: SourceBack = {
  href: "/my?tab=sources",
  label: "My sources",
};

/** The router state a link to a source page carries: where the person came from. */
export const fromPage = (back: SourceBack) => ({ back });

const isBack = (value: unknown): value is SourceBack =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as SourceBack).href === "string" &&
  typeof (value as SourceBack).label === "string";

/**
 * The page the person opened this source from, kept while they move between
 * its tabs; without one (a bookmark, a link from elsewhere), Sources for
 * whoever may read sources, else My sources.
 */
export const useSourceBack = (): SourceBack => {
  const location = useLocation();
  const { hasPermission } = useAuth();
  const [back] = useState<SourceBack>(() => {
    const state = location.state as { back?: unknown } | null;
    if (isBack(state?.back)) return state.back;
    return hasPermission("zeteo.sources.read") ? SOURCES_BACK : MY_DATA_BACK;
  });
  return back;
};
