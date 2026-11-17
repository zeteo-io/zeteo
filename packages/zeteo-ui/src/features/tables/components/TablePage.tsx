import { useCanEditCatalogue } from "../api/useCanEditCatalogue";
import { tableLabel, useAllTables } from "../api/useAllTables";
import type { Relation } from "@/features/relations/api/types";
import { ErrorNotice } from "@/components/ErrorNotice";
import { useUpdateTable } from "../api/useUpdateTable";
import type { Column, PatchTable } from "../api/types";
import { PageHeader } from "@/components/PageHeader";
import { useUuidParam } from "@/lib/useUuidParam";
import { NotFound } from "@/components/NotFound";
import { useTable } from "../api/useTable";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import "./styles.css";
import {
  Badge,
  Button,
  EmptyState,
  Input,
  Spinner,
  Table as DataTable,
  TableFilters,
  type InfiniteScrollMenuFilter,
} from "@kosmeo-ui/react";

const MAX_DESCRIPTION = 2000;

const Counter = ({ text }: { text: string }) =>
  text.length > MAX_DESCRIPTION
    ? `${text.length} / ${MAX_DESCRIPTION}: at most ${MAX_DESCRIPTION} characters`
    : `${text.length} / ${MAX_DESCRIPTION}`;

const tooLong = (text: string) => text.length > MAX_DESCRIPTION;

/** What `PATCH` takes for a field: a blank description clears it. */
const sent = (text: string) => (text.trim() === "" ? null : text.trim());
const changed = (text: string, original: string) =>
  text.trim() !== original.trim();

interface Snapshot {
  description: string;
  columns: Record<string, string>;
}

/** Filter params as TableFilters reports them: `filter[name]`, `filter[type]`. */
type FilterParams = Record<string, string>;

const columnMatches = (column: Column, params: FilterParams): boolean => {
  const name = params["filter[name]"]?.toLowerCase();
  if (name && !column.name.toLowerCase().includes(name)) return false;
  const types = params["filter[type]"]?.split(",");
  if (types && !types.includes(column.type)) return false;
  return true;
};

/** "No" is the usual answer, so it recedes. */
const YesNo = ({ value }: { value: boolean }) =>
  value ? "Yes" : <span className="z-muted">No</span>;

/** Keyed by table, so edit state never carries over to another table. */
export const TablePage = () => {
  const sourceId = useUuidParam("sourceId");
  const tableId = useUuidParam("tableId");
  if (!sourceId || !tableId) return <NotFound />;
  return <TableView key={tableId} sourceId={sourceId} tableId={tableId} />;
};

const TableView = ({
  sourceId,
  tableId,
}: {
  sourceId: string;
  tableId: string;
}) => {
  const { data: table, error, isLoading } = useTable(sourceId, tableId);
  const { labelFor } = useAllTables(sourceId);
  const canEdit = useCanEditCatalogue(sourceId);
  const update = useUpdateTable(sourceId, tableId);

  const [view, setView] = useState<"columns" | "relations">("columns");
  const [params, setParams] = useState<FilterParams>({});
  const [editing, setEditing] = useState(false);
  const [tableText, setTableText] = useState("");
  const [columnText, setColumnText] = useState<Record<string, string>>({});
  // What editing started from: a refetch meanwhile must not count as an edit.
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  // A stable key, so the filter definitions (and their applied values) only
  // reset when the set of types really changes.
  const typeKey = [...new Set((table?.columns ?? []).map((c) => c.type))]
    .sort()
    .join(",");
  const columnFilters = useMemo<InfiniteScrollMenuFilter[]>(
    () => [
      { type: "SEARCH", title: "Name", dataKey: "name" },
      {
        type: "SELECT",
        title: "Type",
        dataKey: "type",
        multiSelect: true,
        options: (typeKey ? typeKey.split(",") : []).map((t) => ({
          id: t,
          name: t,
          selected: false,
        })),
      },
    ],
    [typeKey]
  );

  if (isLoading) return <Spinner size="lg" />;
  if (!table) {
    return (
      <>
        <ErrorNotice error={error} />
        <p>
          <Link to={`/sources/${sourceId}/tables`}>All tables</Link>
        </p>
      </>
    );
  }

  const startEditing = () => {
    const original: Snapshot = {
      description: table.description ?? "",
      columns: Object.fromEntries(
        table.columns.map((c) => [c.name, c.description ?? ""])
      ),
    };
    setSnapshot(original);
    setTableText(original.description);
    setColumnText(original.columns);
    update.reset();
    setEditing(true);
  };

  const overLimit =
    tooLong(tableText) || Object.values(columnText).some(tooLong);

  const save = () => {
    if (!snapshot) return;
    const body: PatchTable = {};
    if (changed(tableText, snapshot.description)) {
      body.description = sent(tableText);
    }
    const columns = Object.keys(snapshot.columns)
      .filter((name) => changed(columnText[name], snapshot.columns[name]))
      .map((name) => ({ name, description: sent(columnText[name]) }));
    if (columns.length > 0) body.columns = columns;
    if (Object.keys(body).length === 0) {
      setEditing(false);
      return;
    }
    update.mutate(body, { onSuccess: () => setEditing(false) });
  };

  const shownColumns = table.columns.filter((c) => columnMatches(c, params));

  const columnCells = (column: Column) =>
    editing && snapshot && column.name in snapshot.columns ? (
      <Input
        aria-label={`Description of column ${column.name}`}
        value={columnText[column.name] ?? ""}
        error={
          tooLong(columnText[column.name] ?? "") ? (
            <Counter text={columnText[column.name]} />
          ) : undefined
        }
        helperText={
          tooLong(columnText[column.name] ?? "") ? undefined : (
            <Counter text={columnText[column.name] ?? ""} />
          )
        }
        onChange={(e) =>
          setColumnText((t) => ({ ...t, [column.name]: e.target.value }))
        }
      />
    ) : (
      (column.description ?? "")
    );

  const actions = canEdit ? (
    <div className="z-header-actions">
      {editing ? (
        <>
          <Button
            variant="secondary"
            fullWidth={false}
            disabled={update.isPending}
            onClick={() => setEditing(false)}
          >
            Cancel
          </Button>
          <Button
            fullWidth={false}
            isLoading={update.isPending}
            disabled={update.isPending || overLimit}
            onClick={save}
          >
            Save
          </Button>
        </>
      ) : (
        <Button variant="secondary" fullWidth={false} onClick={startEditing}>
          Edit descriptions
        </Button>
      )}
    </div>
  ) : undefined;

  return (
    <>
      <Link
        className="z-muted-link z-back-link"
        to={`/sources/${sourceId}/tables`}
      >
        ← All tables
      </Link>
      <div className="z-source-header z-table-header">
        <PageHeader
          title={tableLabel(table)}
          badges={
            <span className="z-table-badges">
              <Badge size="sm" variant="secondary">
                {table.kind === "view" ? "View" : "Table"}
              </Badge>
              {table.missing_since && (
                <Badge size="sm" variant="warning">
                  Missing
                </Badge>
              )}
            </span>
          }
          actions={actions}
          divider={false}
        />
      </div>

      <section className="z-table-intro">
        {editing && <ErrorNotice error={update.error} />}
        {editing ? (
          <Input
            label="Table description"
            value={tableText}
            error={
              tooLong(tableText) ? <Counter text={tableText} /> : undefined
            }
            helperText={
              tooLong(tableText) ? undefined : <Counter text={tableText} />
            }
            onChange={(e) => setTableText(e.target.value)}
          />
        ) : (
          <p
            className={`z-table-description${table.description ? "" : " z-muted"}`}
          >
            {table.description ?? "No description."}
          </p>
        )}
      </section>

      <div
        className="z-segmented z-table-switch"
        role="group"
        aria-label="Show"
      >
        <button
          type="button"
          className="z-segmented-option"
          aria-pressed={view === "columns"}
          onClick={() => setView("columns")}
        >
          Columns
          <span className="z-segmented-count">{table.columns.length}</span>
        </button>
        <button
          type="button"
          className="z-segmented-option"
          aria-pressed={view === "relations"}
          onClick={() => setView("relations")}
        >
          Relations
          <span className="z-segmented-count">{table.relations.length}</span>
        </button>
      </div>

      {view === "columns" ? (
        <>
          <div className="z-list-toolbar">
            <div className="z-list-toolbar-filters">
              <TableFilters filters={columnFilters} onChange={setParams} />
            </div>
          </div>
          <div className="z-wrap z-columns-list">
            <DataTable<Column>
              rowKey={(column) => column.id}
              emptyMessage={
                <EmptyState>
                  {table.columns.length === 0
                    ? "No columns."
                    : "No columns match these filters."}
                </EmptyState>
              }
              columns={[
                {
                  title: "Name",
                  cellElement: (column) => (
                    <span className="z-tables-name">
                      {column.name}
                      {column.is_primary_key && (
                        <Badge size="sm" variant="secondary">
                          Primary key
                        </Badge>
                      )}
                      {column.missing_since && (
                        <Badge size="sm" variant="warning">
                          Missing
                        </Badge>
                      )}
                    </span>
                  ),
                },
                {
                  title: "Type",
                  cellElement: (column) => (
                    <span className="z-column-type">
                      {column.type}
                      {column.native_type !== column.type && (
                        <code className="z-muted" title="Type in the database">
                          {column.native_type}
                        </code>
                      )}
                    </span>
                  ),
                },
                {
                  title: "Nullable",
                  cellElement: (column) => <YesNo value={column.nullable} />,
                },
                { title: "Description", cellElement: columnCells },
              ]}
              rows={shownColumns}
            />
          </div>
        </>
      ) : (
        <>
          <div className="z-list-toolbar z-list-toolbar-end">
            <Link
              className="z-muted-link"
              to={`/sources/${sourceId}/relations`}
            >
              Manage relations
            </Link>
          </div>
          <div className="z-wrap z-relations-list">
            <DataTable<Relation>
              rowKey={(relation) => relation.id}
              emptyMessage={
                <EmptyState>No relations start at this table.</EmptyState>
              }
              columns={[
                {
                  title: "Name",
                  cellElement: (relation) => (
                    <span className="z-tables-name">
                      {relation.name}
                      {relation.missing_since && (
                        <Badge size="sm" variant="warning">
                          Missing
                        </Badge>
                      )}
                    </span>
                  ),
                },
                {
                  title: "To table",
                  cellElement: (relation) => labelFor(relation.to_table_id),
                },
                {
                  title: "Columns",
                  cellElement: (relation) => (
                    <code>
                      {relation.from_columns
                        .map((c, i) => `${c} → ${relation.to_columns[i]}`)
                        .join(", ")}
                    </code>
                  ),
                },
                {
                  title: "To many",
                  cellElement: (relation) => <YesNo value={relation.to_many} />,
                },
                { title: "Origin", dataKey: "origin" },
              ]}
              rows={table.relations}
            />
          </div>
        </>
      )}
    </>
  );
};
