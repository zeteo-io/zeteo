import { PrincipalLabel, PrincipalPicker } from "@/features/principals";
import { formatDuration } from "@/utils/formatDuration";
import { ErrorNotice } from "@/components/ErrorNotice";
import { PageHeader } from "@/components/PageHeader";
import { useUrlFilters } from "@/lib/useUrlFilters";
import { useAllSources } from "@/features/sources";
import { formatDate } from "@/utils/formatDate";
import { OutcomeBadge } from "./OutcomeBadge";
import { useEffect, useState } from "react";
import { useRuns } from "../api/useRuns";
import { RunDetail } from "./RunDetail";
import { useAuth } from "@/lib/auth";
import "./styles.css";
import {
  Alert,
  Button,
  EmptyState,
  Select,
  Spinner,
  Table,
  Badge,
} from "@kosmeo-ui/react";
import {
  RUN_OUTCOMES,
  type Run,
  type RunFilters,
  type RunOutcome,
} from "../api/types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Only well-formed values reach the API: a hand-edited address is ignored. */
const filtersOf = (params: URLSearchParams): RunFilters => {
  const user = params.get("user_id");
  const source = params.get("source_id");
  const outcome = params.get("outcome");
  return {
    user_id: user && UUID.test(user) ? user.toLowerCase() : undefined,
    source_id: source && UUID.test(source) ? source.toLowerCase() : undefined,
    outcome: RUN_OUTCOMES.includes(outcome as RunOutcome)
      ? (outcome as RunOutcome)
      : undefined,
  };
};

export const RunsPage = () => {
  const { can } = useAuth();
  const [filters, setFilters] = useUrlFilters(
    ["user_id", "source_id", "outcome"],
    filtersOf
  );
  const canReadSources = can("zeteo.sources.read");
  const { items, isLoading, error, hasMore, loadMore } = useRuns(filters);
  const sources = useAllSources(canReadSources);
  const [pickingPerson, setPickingPerson] = useState(false);
  const [open, setOpen] = useState<Run | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => setLoadingMore(false), [items.length, hasMore, error]);

  const sourceLabel = (id: string | null) => {
    if (!id) return null;
    const source = sources.sources.find((s) => s.id === id);
    return source ? `${source.name} (${source.slug})` : null;
  };
  const sourcesRefused = sources.error?.status === 403;

  return (
    <>
      <PageHeader
        title="Runs"
        subtitle="Every query and export, newest first"
      />
      <div className="z-runs-filters">
        <Select
          label="Outcome"
          placeholder="Any outcome"
          value={filters.outcome ?? ""}
          options={RUN_OUTCOMES.map((o) => ({ value: o, label: o }))}
          onChange={(o) =>
            setFilters({
              ...filters,
              outcome: (o || undefined) as RunOutcome | undefined,
            })
          }
        />
        {canReadSources && !sourcesRefused && (
          <Select
            label="Source"
            placeholder="All sources"
            value={filters.source_id ?? ""}
            disabled={sources.isLoading}
            options={sources.sources.map((s) => ({
              value: s.id,
              label: `${s.name} (${s.slug})${s.archived_at ? " (archived)" : ""}`,
            }))}
            onChange={(id) =>
              setFilters({ ...filters, source_id: id || undefined })
            }
          />
        )}
      </div>
      {!canReadSources && (
        <Alert variant="warning">
          Filtering by source, and naming sources, needs the Read sources
          permission.
        </Alert>
      )}
      <div className="z-runs-person">
        {(filters.user_id || filters.source_id || filters.outcome) && (
          <ul className="z-runs-chips" aria-label="Active filters">
            {filters.user_id && (
              <li>
                Person:{" "}
                <PrincipalLabel
                  refValue={{ type: "user", id: filters.user_id }}
                />{" "}
                <Button
                  size="sm"
                  variant="secondary"
                  fullWidth={false}
                  aria-label="Clear person"
                  onClick={() => setFilters({ ...filters, user_id: undefined })}
                >
                  Clear
                </Button>
              </li>
            )}
            {filters.source_id && (
              <li>
                Source:{" "}
                <code>
                  {sources.sources.find((x) => x.id === filters.source_id)
                    ?.slug ?? filters.source_id}
                </code>{" "}
                <Button
                  size="sm"
                  variant="secondary"
                  fullWidth={false}
                  aria-label="Clear source"
                  onClick={() =>
                    setFilters({ ...filters, source_id: undefined })
                  }
                >
                  Clear
                </Button>
              </li>
            )}
            {filters.outcome && (
              <li>
                Outcome: <code>{filters.outcome}</code>{" "}
                <Button
                  size="sm"
                  variant="secondary"
                  fullWidth={false}
                  aria-label="Clear outcome"
                  onClick={() => setFilters({ ...filters, outcome: undefined })}
                >
                  Clear
                </Button>
              </li>
            )}
            <li>
              <Button
                size="sm"
                variant="secondary"
                fullWidth={false}
                onClick={() => setFilters({})}
              >
                Clear all
              </Button>
            </li>
          </ul>
        )}
        <Button
          size="sm"
          variant="secondary"
          fullWidth={false}
          aria-expanded={pickingPerson}
          onClick={() => setPickingPerson((o) => !o)}
        >
          {pickingPerson ? "Hide person filter" : "Filter by person"}
        </Button>
        {pickingPerson && (
          <PrincipalPicker
            types={["user"]}
            value={
              filters.user_id ? { type: "user", id: filters.user_id } : null
            }
            onChange={(p) => setFilters({ ...filters, user_id: p.id })}
          />
        )}
      </div>
      <ErrorNotice error={error} />
      <ErrorNotice
        error={sources.error?.status === 403 ? null : sources.error}
      />
      {isLoading ? (
        <Spinner size="lg" />
      ) : (
        <Table<Run>
          rowKey={(run) => run.id}
          emptyMessage={
            error ? undefined : <EmptyState>No runs recorded.</EmptyState>
          }
          columns={[
            { title: "When", cellElement: (run) => formatDate(run.created_at) },
            {
              title: "Person",
              cellElement: (run) => (
                <PrincipalLabel refValue={{ type: "user", id: run.user_id }} />
              ),
            },
            {
              title: "Source",
              cellElement: (run) =>
                run.source_id
                  ? (sourceLabel(run.source_id) ?? <code>{run.source_id}</code>)
                  : "—",
            },
            { title: "Entry point", cellElement: (run) => run.entry_point },
            {
              title: "Outcome",
              cellElement: (run) => <OutcomeBadge outcome={run.outcome} />,
            },
            {
              title: "Duration",
              cellElement: (run) =>
                run.outcome === "running"
                  ? "—"
                  : formatDuration(run.duration_ms),
            },
            { title: "Rows", cellElement: (run) => run.row_count ?? "—" },
            {
              title: "Truncated",
              cellElement: (run) =>
                run.truncated ? (
                  <Badge variant="warning" size="sm">
                    Truncated
                  </Badge>
                ) : (
                  ""
                ),
            },
            {
              title: "Error",
              cellElement: (run) =>
                run.error_code ? <code>{run.error_code}</code> : "—",
            },
            {
              title: "",
              cellElement: (run) => (
                <Button
                  size="sm"
                  variant="secondary"
                  fullWidth={false}
                  onClick={() => setOpen(run)}
                >
                  Details
                </Button>
              ),
            },
          ]}
          rows={items}
        />
      )}
      {hasMore && (
        <div className="z-runs-more">
          <Button
            variant="secondary"
            fullWidth={false}
            isLoading={loadingMore}
            disabled={loadingMore}
            onClick={() => {
              setLoadingMore(true);
              loadMore();
            }}
          >
            Load more
          </Button>
        </div>
      )}
      {open && (
        <RunDetail
          run={open}
          sourceLabel={sourceLabel(open.source_id)}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
};
