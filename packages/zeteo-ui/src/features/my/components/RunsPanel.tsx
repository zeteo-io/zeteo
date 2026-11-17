import { formatCount } from "@/features/sources/components/sourceLabels";
import { OutcomeBadge } from "@/features/runs/components/OutcomeBadge";
import { isUnrecordable, isWithheld, type MyRun } from "../api/types";
import { SaveQueryDialog } from "@/features/saved-queries";
import { formatDuration } from "@/utils/formatDuration";
import { formatRelative } from "@/utils/formatRelative";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Button, Spinner } from "@kosmeo-ui/react";
import { formatDate } from "@/utils/formatDate";
import { useMyRuns } from "../api/useMyRuns";
import { IconAction } from "./IconAction";
import { useState } from "react";
import {
  faBookmark,
  faEye,
  faEyeSlash,
} from "@fortawesome/free-solid-svg-icons";

/** How many runs show at first, and how many more each "Show more" adds. */
export const RUNS_STEP = 10;

const ENTRY_LABEL: Record<MyRun["entry_point"], string> = {
  api: "API",
  mcp: "MCP",
  export: "Export",
};

/** A string field of the run's query JSON, when it has one. */
const fieldOf = (query: unknown, key: "source" | "from"): string | null => {
  if (typeof query !== "object" || query === null) return null;
  const value = (query as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
};

const RunRow = ({
  run,
  onSave,
}: {
  run: MyRun;
  onSave: (query: unknown) => void;
}) => {
  const [open, setOpen] = useState(false);
  const withheld = isWithheld(run.query);
  const hasQuery =
    !withheld &&
    !isUnrecordable(run.query) &&
    typeof run.query === "object" &&
    run.query !== null;
  const source = fieldOf(run.query, "source");
  const from = fieldOf(run.query, "from");
  // A saved query's name, else the table it read, as source.table.
  const what =
    run.saved_query?.name ??
    (source && from ? `${source}.${from}` : (source ?? from));
  return (
    <li className="z-run-row">
      <div className="z-run-line">
        <div className="z-run-main">
          <span className="z-run-what" title={what ?? undefined}>
            {what ?? <span className="z-muted">Query withheld</span>}
          </span>
          <span className="z-run-meta">
            <time dateTime={run.created_at} title={formatDate(run.created_at)}>
              {formatRelative(run.created_at)}
            </time>
            {" · "}
            {ENTRY_LABEL[run.entry_point]}
            {run.row_count !== null && (
              <> · {formatCount(run.row_count)} rows</>
            )}
            {run.truncated && <> · truncated</>}
            {" · "}
            {formatDuration(run.duration_ms)}
            {run.error_code && (
              <>
                {" · "}
                <code>{run.error_code}</code>
              </>
            )}
            {withheld && run.saved_query && <> · Query withheld</>}
          </span>
        </div>
        <OutcomeBadge outcome={run.outcome} />
        <span className="z-run-actions">
          {hasQuery && (
            <>
              <IconAction
                icon={open ? faEyeSlash : faEye}
                label={open ? "Hide query" : "Show query"}
                expanded={open}
                onClick={() => setOpen(!open)}
              />
              <IconAction
                icon={faBookmark}
                label="Save as saved query"
                onClick={() => onSave(run.query)}
              />
            </>
          )}
        </span>
      </div>
      {open && hasQuery && (
        <pre className="z-my-json">{JSON.stringify(run.query, null, 2)}</pre>
      )}
    </li>
  );
};

/** Every run, paged with "Show more"; with `limit`, only that many and no paging. */
export const RunsList = ({ limit }: { limit?: number }) => {
  const { items, isLoading, error, hasMore, loadMore } = useMyRuns();
  const [shown, setShown] = useState(limit ?? RUNS_STEP);
  const [saving, setSaving] = useState<{ query: unknown } | null>(null);
  const visible = items.slice(0, shown);
  const more = limit === undefined && (items.length > shown || hasMore);

  const showMore = () => {
    const next = shown + RUNS_STEP;
    setShown(next);
    if (next > items.length && hasMore) loadMore();
  };

  return (
    <>
      {isLoading && <Spinner size="sm" />}
      <ErrorNotice error={error} />
      {!isLoading && !error && items.length === 0 && (
        <p className="z-note">You have not run anything yet.</p>
      )}
      {visible.length > 0 && (
        <ul className="z-run-list" aria-label="Recent runs">
          {visible.map((run) => (
            <RunRow
              key={run.id}
              run={run}
              onSave={(query) => setSaving({ query })}
            />
          ))}
        </ul>
      )}
      {more && (
        <div className="z-my-more">
          <Button
            size="sm"
            variant="secondary"
            fullWidth={false}
            onClick={showMore}
          >
            Show more
          </Button>
        </div>
      )}
      {saving && (
        <SaveQueryDialog query={saving.query} onClose={() => setSaving(null)} />
      )}
    </>
  );
};
