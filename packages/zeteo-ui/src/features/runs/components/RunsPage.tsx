import { formatCount } from "@/features/sources/components/sourceLabels";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { OUTCOME_LABEL, OutcomeBadge } from "./OutcomeBadge";
import { faUser } from "@fortawesome/free-solid-svg-icons";
import { formatDuration } from "@/utils/formatDuration";
import { formatRelative } from "@/utils/formatRelative";
import { ErrorNotice } from "@/components/ErrorNotice";
import { PageHeader } from "@/components/PageHeader";
import { FilterChip } from "@/components/FilterChip";
import { useUrlFilters } from "@/lib/useUrlFilters";
import { useAllSources } from "@/features/sources";
import { formatDate } from "@/utils/formatDate";
import { useEffect, useState } from "react";
import { useAuth } from "@tereo-io/react";
import { useRuns } from "../api/useRuns";
import { Link } from "react-router-dom";
import { RunDetail } from "./RunDetail";
import "./styles.css";
import {
  PrincipalCell,
  PrincipalLabel,
  PrincipalPicker,
} from "@/features/principals";
import {
  Alert,
  Button,
  EmptyState,
  Modal,
  Spinner,
  Table,
  TableFilters,
  Badge,
  type InfiniteScrollMenuFilter,
} from "@kosmeo-ui/react";
import {
  RUN_OUTCOMES,
  type Run,
  type RunFilters,
  type RunOutcome,
} from "../api/types";

const ENTRY_LABEL: Record<Run["entry_point"], string> = {
  api: "API",
  mcp: "MCP",
  export: "Export",
};

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
  const { hasPermission } = useAuth();
  const [filters, setFilters] = useUrlFilters(
    ["user_id", "source_id", "outcome"],
    filtersOf
  );
  const canReadSources = hasPermission("zeteo.sources.read");
  // GET /v1/principals needs zeteo.grants.read; a lookup by id needs only runs.
  const canSearchPeople = hasPermission("zeteo.grants.read");
  const anyFilter = !!(filters.user_id || filters.source_id || filters.outcome);
  const { items, isLoading, error, hasMore, loadMore } = useRuns(filters);
  const sources = useAllSources(canReadSources);
  const [pickingPerson, setPickingPerson] = useState(false);
  const [open, setOpen] = useState<Run | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => setLoadingMore(false), [items.length, hasMore, error]);

  const sourceLabel = (id: string | null) => {
    if (!id) return null;
    const source = sources.sources.find((s) => s.id === id);
    return source ? source.name : null;
  };
  const sourcesRefused = sources.error?.status === 403;

  const userRef = filters.user_id
    ? ({ type: "user", id: filters.user_id } as const)
    : null;

  const sourceSelect = canReadSources && !sourcesRefused;
  // A source from the address that the filter cannot show is a chip.
  const sourceChip =
    filters.source_id && !sourceSelect ? filters.source_id : null;

  // The current choices go into the definitions, so TableFilters, which
  // starts over whenever they change, starts over where it already was.
  const filterDefs: InfiniteScrollMenuFilter[] = [
    {
      type: "SELECT",
      title: "Outcome",
      dataKey: "outcome",
      options: RUN_OUTCOMES.map((o) => ({
        id: o,
        name: OUTCOME_LABEL[o],
        selected: o === filters.outcome,
      })),
    },
    ...(sourceSelect
      ? [
          {
            type: "SELECT" as const,
            title: "Source",
            dataKey: "source_id",
            options: sources.sources.map((s) => ({
              id: s.id,
              name: `${s.name}${s.archived_at ? " (archived)" : ""}`,
              selected: s.id === filters.source_id,
            })),
          },
        ]
      : []),
  ];
  // It reports its choices as soon as it mounts, so it waits for the options
  // that hold the current choices; otherwise it would report them gone.
  const filtersReady = !(sourceSelect && sources.isLoading);

  const onFiltersChange = (params: Record<string, string>) => {
    const outcome = (params["filter[outcome]"] || undefined) as
      RunOutcome | undefined;
    const source_id = sourceSelect
      ? params["filter[source_id]"] || undefined
      : filters.source_id;
    if (outcome !== filters.outcome || source_id !== filters.source_id) {
      setFilters({ ...filters, outcome, source_id });
    }
  };

  return (
    <>
      <PageHeader title="Runs" divider={false} />
      <div className="z-list-toolbar">
        <div className="z-list-toolbar-filters z-runs-toolbar">
          {userRef ? (
            <FilterChip
              clearLabel="Clear person"
              onClear={() => setFilters({ ...filters, user_id: undefined })}
            >
              <PrincipalLabel refValue={userRef} />
            </FilterChip>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              fullWidth={false}
              onClick={() => setPickingPerson(true)}
            >
              <FontAwesomeIcon icon={faUser} /> Person
            </Button>
          )}
          {sourceChip && (
            <FilterChip
              clearLabel="Clear source"
              onClear={() => setFilters({ ...filters, source_id: undefined })}
            >
              Source: {sourceChip}
            </FilterChip>
          )}
          {filtersReady && (
            <div className="z-runs-tablefilters">
              <TableFilters filters={filterDefs} onChange={onFiltersChange} />
            </div>
          )}
        </div>
      </div>
      {!canReadSources && (
        <Alert variant="warning">
          Filtering by source, and naming sources, needs the Read sources
          permission.
        </Alert>
      )}
      <Modal
        show={pickingPerson}
        title="Show the runs of a person"
        onClose={() => setPickingPerson(false)}
      >
        {!canSearchPeople && (
          <p>
            Searching by name needs the Read grants permission; paste a user id
            instead.
          </p>
        )}
        <PrincipalPicker
          types={["user"]}
          search={canSearchPeople}
          value={userRef}
          onChange={(p) => {
            setFilters({ ...filters, user_id: p.id });
            setPickingPerson(false);
          }}
        />
      </Modal>
      <ErrorNotice error={error} />
      <ErrorNotice
        error={sources.error?.status === 403 ? null : sources.error}
      />
      {isLoading ? (
        <Spinner size="lg" />
      ) : (
        <div className="z-actions-last z-runs-list">
          <Table<Run>
            rowKey={(run) => run.id}
            emptyMessage={
              error ? undefined : (
                <EmptyState>
                  {anyFilter
                    ? "No run matches these filters."
                    : "No runs recorded."}
                </EmptyState>
              )
            }
            columns={[
              {
                title: "When",
                cellElement: (run) => (
                  <time title={formatDate(run.created_at)}>
                    {formatRelative(run.created_at)}
                  </time>
                ),
              },
              {
                title: "Person",
                cellElement: (run) => (
                  <PrincipalCell
                    principal_type="user"
                    principal_id={run.user_id}
                    status="active"
                  />
                ),
              },
              {
                title: "Source",
                cellElement: (run) =>
                  run.source_id ? (
                    <Link
                      className="z-plain-link"
                      to={`/sources/${run.source_id}`}
                    >
                      {sourceLabel(run.source_id) ?? (
                        <code>{run.source_id}</code>
                      )}
                    </Link>
                  ) : (
                    <span className="z-muted">—</span>
                  ),
              },
              {
                title: "Saved query",
                cellElement: (run) =>
                  run.saved_query ? (
                    run.saved_query.name
                  ) : (
                    <span className="z-muted">—</span>
                  ),
              },
              {
                title: "Entry point",
                cellElement: (run) => ENTRY_LABEL[run.entry_point],
              },
              {
                title: "Outcome",
                width: "1%",
                cellElement: (run) => <OutcomeBadge outcome={run.outcome} />,
              },
              {
                title: "Duration",
                cellElement: (run) =>
                  run.outcome === "running"
                    ? "—"
                    : formatDuration(run.duration_ms),
              },
              {
                title: "Rows",
                cellElement: (run) =>
                  run.row_count === null ? (
                    <span className="z-muted">—</span>
                  ) : (
                    <span className="z-runs-rows">
                      {formatCount(run.row_count)}
                      {run.truncated && (
                        <Badge variant="warning" size="sm">
                          Truncated
                        </Badge>
                      )}
                    </span>
                  ),
              },
              {
                title: "Error",
                cellElement: (run) =>
                  run.error_code ? (
                    <code className="z-muted">{run.error_code}</code>
                  ) : null,
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
        </div>
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
