import { isRedacted, type Measure, type MeasureListItem } from "../api/types";
import { MeasureEditorsDialog } from "./MeasureEditorsDialog";
import { faTrash } from "@fortawesome/free-solid-svg-icons";
import { useDeleteMeasure } from "../api/useDeleteMeasure";
import { ConfirmButton } from "@/components/ConfirmButton";
import { ErrorNotice } from "@/components/ErrorNotice";
import { EditButton } from "@/components/EditButton";
import { useMeasures } from "../api/useMeasures";
import { MeasureDialog } from "./MeasureDialog";
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

const FILTERS: InfiniteScrollMenuFilter[] = [
  { type: "SEARCH", title: "Search", dataKey: "q" },
];

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

const usedText = (m: Measure) =>
  m.used_by
    ? `${plural(m.used_by.saved_queries, "saved query", "saved queries")} and ${plural(m.used_by.panels, "panel", "panels")}`
    : null;

interface MeasuresTabProps {
  sourceId: string;
  /** Creates, changes and deletes: `zeteo.measures.write` on a source that is not archived. */
  canWrite: boolean;
  /** Replaces the editor list: a sources admin, or an upload's owner. */
  canManageEditors: boolean;
}

const nameOf = (m: MeasureListItem) => m.name;

/** A source's Measures tab. */
export const MeasuresTab = ({
  sourceId,
  canWrite,
  canManageEditors,
}: MeasuresTabProps) => {
  const { data, isLoading, error } = useMeasures(sourceId);
  const del = useDeleteMeasure(sourceId);
  const [params, setParams] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<Measure | "new" | null>(null);
  const [managing, setManaging] = useState(false);

  const q = params["filter[q]"]?.toLowerCase();
  const shown = (data ?? []).filter(
    (m) =>
      !q ||
      m.name.toLowerCase().includes(q) ||
      m.table.toLowerCase().includes(q) ||
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
            {canWrite && (
              <Button
                size="sm"
                fullWidth={false}
                onClick={() => setEditing("new")}
              >
                New measure
              </Button>
            )}
          </div>
        </div>
      </div>
      {editing && (
        <MeasureDialog
          // A new key per measure so its fields start from it.
          key={editing === "new" ? "new" : editing.id}
          sourceId={sourceId}
          {...(editing !== "new" && { measure: editing })}
          onClose={() => setEditing(null)}
        />
      )}
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
        <div className="z-wrap">
          <Table<MeasureListItem>
            rowKey={nameOf}
            emptyMessage={
              error ? undefined : (data ?? []).length === 0 ? (
                <EmptyState>No measures yet.</EmptyState>
              ) : (
                <EmptyState>No measures match this search.</EmptyState>
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
                      {!isRedacted(m) && m.broken && (
                        <span title={m.broken.message}>
                          <Badge size="sm" variant="danger">
                            Broken
                          </Badge>
                        </span>
                      )}
                    </span>
                    {!isRedacted(m) && m.broken && (
                      <span className="z-measure-broken">
                        {m.broken.message}
                      </span>
                    )}
                  </div>
                ),
              },
              { title: "Table", cellElement: (m) => <code>{m.table}</code> },
              { title: "Description", cellElement: (m) => m.description },
              {
                title: "Used by",
                cellElement: (m) =>
                  (!isRedacted(m) && usedText(m)) || (
                    <span className="z-muted">—</span>
                  ),
              },
              ...(canWrite
                ? [
                    {
                      title: "",
                      cellElement: (m: MeasureListItem) =>
                        isRedacted(m) ? null : (
                          <RowActions align="end">
                            <EditButton onClick={() => setEditing(m)} />
                            <ConfirmButton
                              danger
                              size="sm"
                              icon={faTrash}
                              label="Delete"
                              confirmTitle="Delete this measure?"
                              confirmText={
                                m.used_by &&
                                (m.used_by.saved_queries > 0 ||
                                  m.used_by.panels > 0)
                                  ? `${m.name} is used by ${usedText(m)}. They will stop working.`
                                  : `${m.name} is not used by any saved query or panel.`
                              }
                              confirmLabel="Delete measure"
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
