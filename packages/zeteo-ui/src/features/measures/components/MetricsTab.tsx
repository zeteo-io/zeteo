import { MeasureEditorsDialog } from "./MeasureEditorsDialog";
import { faTrash } from "@fortawesome/free-solid-svg-icons";
import { ConfirmButton } from "@/components/ConfirmButton";
import { useDeleteMetric } from "../api/useDeleteMetric";
import { ErrorNotice } from "@/components/ErrorNotice";
import { EditButton } from "@/components/EditButton";
import { useMetrics } from "../api/useMetrics";
import { useNavigate } from "react-router-dom";
import { useState } from "react";
import "./styles.css";
import {
  Badge,
  Button,
  EmptyState,
  RowActions,
  Spinner,
  Table,
  TableFilters,
  type InfiniteScrollMenuFilter,
} from "@kosmeo-ui/react";
import {
  isRedactedMetric,
  type Metric,
  type MetricListItem,
} from "../api/types";

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

const usedText = (m: Metric) =>
  m.used_by
    ? `${plural(m.used_by.saved_queries, "saved query", "saved queries")} and ${plural(m.used_by.panels, "panel", "panels")}`
    : null;

/** The measures a formula names, in order of first use. */
const measuresUsed = (formula: unknown): string[] => {
  const names = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v !== "object" || v === null) return;
    const rec = v as Record<string, unknown>;
    if (typeof rec.measure === "string") names.add(rec.measure);
    else Object.values(rec).forEach(walk);
  };
  walk(formula);
  return [...names];
};

const FILTERS: InfiniteScrollMenuFilter[] = [
  { type: "SEARCH", title: "Search", dataKey: "q" },
];

interface MetricsTabProps {
  sourceId: string;
  /** May hold `zeteo.measures.write`; the list's `can_edit` decides whether the actions show. */
  canWrite: boolean;
  /** Replaces the editor list (shared with measures): a sources admin, or an upload's owner. */
  canManageEditors: boolean;
}

/** A source's Metrics tab: formulas over measures, asked for in a metric query; creating and changing one are pages of their own. */
export const MetricsTab = ({
  sourceId,
  canWrite,
  canManageEditors,
}: MetricsTabProps) => {
  const { data: list, isLoading, error } = useMetrics(sourceId);
  const data = list?.data ?? [];
  const canEdit = canWrite && !!list?.can_edit;
  const joinHint =
    canWrite && !!list && !list.can_edit && list.can_manage_editors;
  const del = useDeleteMetric(sourceId);
  const navigate = useNavigate();
  const base = `/sources/${sourceId}/metrics`;
  const [params, setParams] = useState<Record<string, string>>({});
  const [managing, setManaging] = useState(false);
  const q = params["filter[q]"]?.toLowerCase();
  const shown = data.filter(
    (m) =>
      !q ||
      m.name.toLowerCase().includes(q) ||
      m.description.toLowerCase().includes(q)
  );

  return (
    <>
      <div className="z-list-toolbar">
        <div className="z-list-toolbar-filters">
          <TableFilters filters={FILTERS} onChange={setParams} />
        </div>
        <div className="z-list-toolbar-side">
          <div className="z-measure-name">
            {canManageEditors && (
              <Button
                size="sm"
                variant="secondary"
                fullWidth={false}
                onClick={() => setManaging(true)}
              >
                Editors
              </Button>
            )}
            {canEdit && (
              <Button
                size="sm"
                fullWidth={false}
                onClick={() => navigate(`${base}/new`)}
              >
                New metric
              </Button>
            )}
          </div>
          {joinHint && (
            <small className="z-muted">
              Add yourself as an editor to create or change metrics.
            </small>
          )}
        </div>
      </div>
      {managing && (
        <MeasureEditorsDialog
          sourceId={sourceId}
          onClose={() => setManaging(false)}
        />
      )}
      <ErrorNotice error={error} />
      {isLoading ? (
        <Spinner size="lg" />
      ) : (
        <div className={canEdit ? "z-wrap z-actions-last" : "z-wrap"}>
          <Table<MetricListItem>
            rowKey={(m) => m.name}
            emptyMessage={
              error ? undefined : data.length === 0 ? (
                <EmptyState>No metrics yet.</EmptyState>
              ) : (
                <EmptyState>No metrics match this search.</EmptyState>
              )
            }
            columns={[
              {
                title: "Name",
                cellElement: (m) => (
                  <div>
                    <span className="z-measure-name">
                      <strong>{m.name}</strong>
                      {!m.usable && (
                        <Badge size="sm" variant="secondary">
                          Not usable by you
                        </Badge>
                      )}
                      {!isRedactedMetric(m) && m.broken && (
                        <span title={m.broken.message}>
                          <Badge size="sm" variant="danger">
                            Broken
                          </Badge>
                        </span>
                      )}
                    </span>
                    {!isRedactedMetric(m) && m.broken && (
                      <span className="z-measure-broken">
                        {m.broken.message}
                      </span>
                    )}
                  </div>
                ),
              },
              { title: "Description", cellElement: (m) => m.description },
              {
                title: "Measures",
                cellElement: (m) =>
                  isRedactedMetric(m) ? (
                    <span className="z-muted">—</span>
                  ) : (
                    measuresUsed(m.formula).map((n) => (
                      <code key={n}>{n} </code>
                    ))
                  ),
              },
              {
                title: "Used by",
                cellElement: (m) =>
                  (!isRedactedMetric(m) && usedText(m)) || (
                    <span className="z-muted">—</span>
                  ),
              },
              ...(canEdit
                ? [
                    {
                      title: "",
                      cellElement: (m: MetricListItem) =>
                        isRedactedMetric(m) ? null : (
                          <RowActions align="end">
                            <EditButton
                              onClick={() => navigate(`${base}/${m.id}/edit`)}
                            />
                            <ConfirmButton
                              danger
                              size="sm"
                              icon={faTrash}
                              label="Delete"
                              confirmTitle="Delete this metric?"
                              confirmText={
                                m.used_by
                                  ? `${m.name} is used by ${usedText(m)}; they will stop working.`
                                  : `${m.name} may be used by saved queries and panels; they will stop working.`
                              }
                              confirmLabel="Delete metric"
                              onConfirm={() => del.mutateAsync(m.id)}
                            />
                          </RowActions>
                        ),
                    },
                  ]
                : []),
            ]}
            rows={shown}
          />
        </div>
      )}
    </>
  );
};
