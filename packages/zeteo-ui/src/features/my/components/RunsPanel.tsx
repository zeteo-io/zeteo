import { Badge, BorderedSection, Button, Spinner } from "@kosmeo-ui/react";
import { formatCount } from "@/features/sources/components/sourceLabels";
import { OutcomeBadge } from "@/features/runs/components/OutcomeBadge";
import { isUnrecordable, isWithheld, type MyRun } from "../api/types";
import { SaveQueryDialog } from "@/features/saved-queries";
import { formatDuration } from "@/utils/formatDuration";
import { formatRelative } from "@/utils/formatRelative";
import { ErrorNotice } from "@/components/ErrorNotice";
import { formatDate } from "@/utils/formatDate";
import { useMyRuns } from "../api/useMyRuns";
import { useState } from "react";

const ENTRY_LABEL: Record<MyRun["entry_point"], string> = {
  api: "API",
  mcp: "MCP",
  export: "Export",
};

const sourceOf = (query: unknown): string | null =>
  typeof query === "object" &&
  query !== null &&
  typeof (query as { source?: unknown }).source === "string"
    ? (query as { source: string }).source
    : null;

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
  const source = sourceOf(run.query);
  return (
    <li className="z-run-row">
      <div className="z-run-line">
        <time dateTime={run.created_at} title={formatDate(run.created_at)}>
          {formatRelative(run.created_at)}
        </time>
        <Badge size="sm" variant="secondary">
          {ENTRY_LABEL[run.entry_point]}
        </Badge>
        {run.saved_query && <span>{run.saved_query.name}</span>}
        {source && <span className="z-sq-source">{source}</span>}
        <OutcomeBadge outcome={run.outcome} />
        {run.row_count !== null && (
          <span>{formatCount(run.row_count)} rows</span>
        )}
        {run.truncated && (
          <Badge size="sm" variant="secondary">
            Truncated
          </Badge>
        )}
        <span className="z-muted">{formatDuration(run.duration_ms)}</span>
        {run.error_code && <code>{run.error_code}</code>}
        {withheld && <span className="z-muted">Query withheld</span>}
        <span className="z-run-actions">
          {hasQuery && (
            <>
              <Button
                size="sm"
                variant="secondary"
                fullWidth={false}
                aria-expanded={open}
                onClick={() => setOpen(!open)}
              >
                {open ? "Hide query" : "Show query"}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                fullWidth={false}
                onClick={() => onSave(run.query)}
              >
                Save as saved query
              </Button>
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

export const RunsPanel = () => {
  const { items, isLoading, error, hasMore, loadMore } = useMyRuns();
  const [saving, setSaving] = useState<{ query: unknown } | null>(null);
  return (
    <BorderedSection title="My recent runs" as="h2">
      {isLoading && <Spinner size="sm" />}
      <ErrorNotice error={error} />
      {!isLoading && !error && items.length === 0 && (
        <p className="z-muted">You have not run anything yet.</p>
      )}
      {items.length > 0 && (
        <ul className="z-run-list" aria-label="Recent runs">
          {items.map((run) => (
            <RunRow
              key={run.id}
              run={run}
              onSave={(query) => setSaving({ query })}
            />
          ))}
        </ul>
      )}
      {hasMore && (
        <Button
          size="sm"
          variant="secondary"
          fullWidth={false}
          onClick={loadMore}
        >
          Load more
        </Button>
      )}
      {saving && (
        <SaveQueryDialog query={saving.query} onClose={() => setSaving(null)} />
      )}
    </BorderedSection>
  );
};
