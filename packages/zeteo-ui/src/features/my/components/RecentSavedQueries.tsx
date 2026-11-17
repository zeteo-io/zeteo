import type { SavedQuery } from "@/features/saved-queries";
import { formatRelative } from "@/utils/formatRelative";
import { ErrorNotice } from "@/components/ErrorNotice";
import { formatDate } from "@/utils/formatDate";
import { Spinner } from "@kosmeo-ui/react";
import { Link } from "react-router-dom";
import { savedQueryHref } from "./tabs";

/** How many saved queries the overview lists. */
export const RECENT_SAVED_QUERIES = 5;

interface List {
  items: SavedQuery[];
  isLoading: boolean;
  error: Parameters<typeof ErrorNotice>[0]["error"];
}

/** When the caller last used it: their own last run, else when it was saved or shared. */
const usedAt = (sq: SavedQuery) =>
  sq.you_last_ran_at ?? sq.shared_at ?? sq.updated_at;

/** The caller's own and shared saved queries, most recently used first. */
export const RecentSavedQueries = ({
  mine,
  shared,
}: {
  mine: List;
  shared: List;
}) => {
  const recent = [
    ...mine.items.map((sq) => ({ sq, tab: "mine" as const })),
    ...shared.items.map((sq) => ({ sq, tab: "shared" as const })),
  ]
    .sort((a, b) => usedAt(b.sq).localeCompare(usedAt(a.sq)))
    .slice(0, RECENT_SAVED_QUERIES);

  if (mine.isLoading || shared.isLoading) return <Spinner size="sm" />;
  return (
    <>
      <ErrorNotice error={mine.error ?? shared.error} />
      {recent.length === 0 ? (
        <p className="z-note">
          No saved queries yet. Save a query from one of your recent runs, or
          ask your AI assistant to save one.
        </p>
      ) : (
        <ul className="z-run-list" aria-label="Recently used saved queries">
          {recent.map(({ sq, tab }) => (
            <li key={sq.id} className="z-run-row">
              <div className="z-run-line">
                <div className="z-run-main">
                  <Link
                    className="z-plain-link z-run-what"
                    to={savedQueryHref(sq.id)}
                  >
                    {sq.name}
                  </Link>
                  <span className="z-run-meta">
                    {tab === "shared"
                      ? `From ${sq.owner.name ?? "someone"}`
                      : "Yours"}
                    {sq.accessible && sq.source && <> · {sq.source.slug}</>}
                    {" · "}
                    {sq.you_last_ran_at ? (
                      <>
                        you ran it{" "}
                        <time title={formatDate(sq.you_last_ran_at)}>
                          {formatRelative(sq.you_last_ran_at)}
                        </time>
                      </>
                    ) : (
                      "not run by you yet"
                    )}
                    {!sq.accessible && <> · needs expanded permissions</>}
                  </span>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
};
