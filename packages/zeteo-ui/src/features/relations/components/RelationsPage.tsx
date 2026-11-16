import { useDeleteRelation } from "../api/useDeleteRelation";
import { faTrash } from "@fortawesome/free-solid-svg-icons";
import { ConfirmButton } from "@/components/ConfirmButton";
import { useAllRelations } from "../api/useAllRelations";
import { ErrorNotice } from "@/components/ErrorNotice";
import { useUuidParam } from "@/lib/useUuidParam";
import { NotFound } from "@/components/NotFound";
import { RelationForm } from "./RelationForm";
import type { Relation } from "../api/types";
import { useMemo, useState } from "react";
import "./styles.css";
import {
  useAllTables,
  useCanEditCatalogue,
  type Table,
} from "@/features/tables";
import {
  Badge,
  Button,
  EmptyState,
  Spinner,
  Table as DataTable,
  TableFilters,
  type InfiniteScrollMenuFilter,
} from "@kosmeo-ui/react";

export const RelationsPage = () => {
  const sourceId = useUuidParam("sourceId");
  return sourceId ? <Relations sourceId={sourceId} /> : <NotFound />;
};

type FilterParams = Record<string, string>;

const TableName = ({
  table,
  id,
  loading,
}: {
  table: Table | undefined;
  id: string;
  /** The tables are still loading: a placeholder, not the raw id. */
  loading: boolean;
}) =>
  table ? (
    <span className="z-relation-table">
      <span className="z-muted">{table.schema_name}.</span>
      {table.name}
    </span>
  ) : loading ? (
    <span className="z-muted">…</span>
  ) : (
    <code>{id}</code>
  );

/** `id` when both sides share their column names, else `a, b → c, d`. */
const keys = (r: Relation) =>
  r.from_columns.join(",") === r.to_columns.join(",")
    ? r.from_columns.join(", ")
    : `${r.from_columns.join(", ")} → ${r.to_columns.join(", ")}`;

const Relations = ({ sourceId }: { sourceId: string }) => {
  const { relations, isLoading, error } = useAllRelations(sourceId);
  const {
    tables,
    isLoading: tablesLoading,
    error: tablesError,
  } = useAllTables(sourceId);
  const canEdit = useCanEditCatalogue(sourceId);
  const del = useDeleteRelation(sourceId);
  const [declaring, setDeclaring] = useState(false);
  const [params, setParams] = useState<FilterParams>({});

  const byId = useMemo(() => new Map(tables.map((t) => [t.id, t])), [tables]);
  const label = (id: string) => {
    const t = byId.get(id);
    return t ? `${t.schema_name}.${t.name}` : id;
  };

  // Only tables that take part in a relation; a stable key so the filter
  // definitions reset only when that set really changes.
  const tableKey = [
    ...new Set(relations.flatMap((r) => [r.from_table_id, r.to_table_id])),
  ]
    .filter((id) => byId.has(id))
    .sort((a, b) => label(a).localeCompare(label(b)))
    .join(",");
  const filters = useMemo<InfiniteScrollMenuFilter[]>(
    () => [
      { type: "SEARCH", title: "Search", dataKey: "q" },
      {
        type: "SELECT",
        title: "Table",
        dataKey: "table",
        options: (tableKey ? tableKey.split(",") : []).map((id) => ({
          id,
          name: label(id),
          selected: false,
        })),
      },
      {
        type: "SELECT",
        title: "Returns",
        dataKey: "returns",
        options: [
          { id: "one", name: "One", selected: false },
          { id: "many", name: "Many", selected: false },
        ],
      },
      {
        type: "SELECT",
        title: "Origin",
        dataKey: "origin",
        options: [
          { id: "discovered", name: "Discovered", selected: false },
          { id: "declared", name: "Declared", selected: false },
        ],
      },
    ],
    // label reads byId, which tableKey already reflects.
    [tableKey]
  );

  const q = params["filter[q]"]?.toLowerCase();
  const table = params["filter[table]"];
  const returns = params["filter[returns]"];
  const origin = params["filter[origin]"];
  const shown = relations.filter(
    (r) =>
      (!q ||
        r.name.toLowerCase().includes(q) ||
        label(r.from_table_id).toLowerCase().includes(q) ||
        label(r.to_table_id).toLowerCase().includes(q)) &&
      (!table || r.from_table_id === table || r.to_table_id === table) &&
      (!returns || (returns === "many") === r.to_many) &&
      (!origin || r.origin === origin)
  );
  const anyDeclared = shown.some((r) => r.origin === "declared");

  return (
    <>
      <div className="z-list-toolbar">
        <div className="z-list-toolbar-filters">
          <TableFilters filters={filters} onChange={setParams} />
        </div>
        <div className="z-list-toolbar-side">
          {canEdit && (
            <Button
              size="sm"
              fullWidth={false}
              disabled={tablesLoading || !!tablesError}
              onClick={() => setDeclaring(true)}
            >
              Declare relation
            </Button>
          )}
        </div>
      </div>
      {canEdit && declaring && (
        <RelationForm
          sourceId={sourceId}
          tables={tables.filter((t) => !t.missing_since)}
          onDeclared={() => setDeclaring(false)}
          onClose={() => setDeclaring(false)}
        />
      )}
      <ErrorNotice error={error} />
      <ErrorNotice error={tablesError} />
      {isLoading ? (
        <Spinner size="lg" />
      ) : (
        <div className="z-wrap z-relations-list">
          <DataTable<Relation>
            rowKey={(relation) => relation.id}
            emptyMessage={
              error ? undefined : relations.length === 0 ? (
                <EmptyState>
                  No relations yet. Refresh the catalogue to discover them, or
                  declare one.
                </EmptyState>
              ) : (
                <EmptyState>No relations match these filters.</EmptyState>
              )
            }
            columns={[
              {
                title: "From",
                cellElement: (r) => (
                  <TableName
                    table={byId.get(r.from_table_id)}
                    id={r.from_table_id}
                    loading={tablesLoading}
                  />
                ),
              },
              {
                title: "Join as",
                cellElement: (r) => (
                  <span className="z-relation-name">
                    <strong>{r.name}</strong>
                    {r.origin === "declared" && (
                      <Badge size="sm" variant="secondary">
                        Declared
                      </Badge>
                    )}
                    {r.missing_since && (
                      <Badge size="sm" variant="warning">
                        Missing
                      </Badge>
                    )}
                  </span>
                ),
              },
              {
                title: "To",
                cellElement: (r) => (
                  <TableName
                    table={byId.get(r.to_table_id)}
                    id={r.to_table_id}
                    loading={tablesLoading}
                  />
                ),
              },
              {
                title: "On",
                cellElement: (r) => <code className="z-muted">{keys(r)}</code>,
              },
              {
                title: "Returns",
                cellElement: (r) => (r.to_many ? "Many" : "One"),
              },
              ...(canEdit && anyDeclared
                ? [
                    {
                      title: "",
                      cellElement: (r: Relation) =>
                        r.origin === "declared" ? (
                          <ConfirmButton
                            danger
                            size="sm"
                            icon={faTrash}
                            label="Delete"
                            confirmTitle="Delete this relation?"
                            confirmText={`Queries can no longer join through ${r.name}. Grants are not affected.`}
                            confirmLabel="Delete relation"
                            onConfirm={() => del.mutateAsync(r.id)}
                          />
                        ) : null,
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
