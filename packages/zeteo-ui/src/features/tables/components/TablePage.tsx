import { useCanEditCatalogue } from "../api/useCanEditCatalogue";
import { tableLabel, useAllTables } from "../api/useAllTables";
import type { Relation } from "@/features/relations/api/types";
import { useMemo, useState, type ReactNode } from "react";
import { ErrorNotice } from "@/components/ErrorNotice";
import { useUpdateTable } from "../api/useUpdateTable";
import type { Column, PatchTable } from "../api/types";
import { PageHeader } from "@/components/PageHeader";
import { useUuidParam } from "@/lib/useUuidParam";
import { NotFound } from "@/components/NotFound";
import { useTable } from "../api/useTable";
import type { ApiError } from "@/lib/api";
import { Link } from "react-router-dom";
import "./styles.css";
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Input,
  SearchSelect,
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

/** A column as editing found it, by id: what the server has. */
interface ColumnState {
  name: string;
  type: string;
  description: string;
}

interface Snapshot {
  description: string;
  columns: Record<string, ColumnState>;
}

/** The type choices of an upload's columns. */
export interface ColumnTypeChoice {
  id: string;
  label: string;
}

/** For an upload: its columns are renamed and retyped in the edit mode too. */
export interface ColumnEditing {
  types: ColumnTypeChoice[];
  /** Why a column cannot take this name; undefined when it can. */
  nameProblem: (name: string) => string | undefined;
  /** Saves one column's new name, type or both. */
  saveColumn: (
    columnId: string,
    change: { name?: string; type?: string }
  ) => Promise<unknown>;
  /** Shown while any column's type is changed. */
  retypeWarning: ReactNode;
  /** A failed column save, a `cast_failed` naming the column and its rows. */
  failure: (error: ApiError) => ReactNode;
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
  return <DatabaseTable key={tableId} sourceId={sourceId} tableId={tableId} />;
};

const DatabaseTable = ({
  sourceId,
  tableId,
}: {
  sourceId: string;
  tableId: string;
}) => (
  <TableView
    sourceId={sourceId}
    tableId={tableId}
    canEdit={useCanEditCatalogue(sourceId)}
    tablesHref={`/sources/${sourceId}/tables`}
    relationsHref={`/sources/${sourceId}/relations`}
  />
);

export interface TableViewProps {
  sourceId: string;
  tableId: string;
  /** Whether the caller may describe the table and its columns. */
  canEdit: boolean;
  /** The source's list of tables, for the back link. */
  tablesHref: string;
  /** Where the source's relations are managed. */
  relationsHref: string;
  /** `upload`: an upload source, whose tables have no schema, database types or nullability to show. */
  catalogue?: "database" | "upload";
  /** Actions beside "Edit descriptions" ("Edit columns"), for what only this kind of source has. */
  headerActions?: ReactNode;
  /** Shown after a column's name. */
  columnNote?: (column: Column) => ReactNode;
  /** Renaming and retyping columns in the edit mode (an upload's). */
  columnEditing?: ColumnEditing;
}

/** One table of a source: the table page of a database source, and of an upload source. Key it by table, so edit state never carries over. */
export const TableView = ({
  sourceId,
  tableId,
  canEdit,
  tablesHref,
  relationsHref,
  catalogue = "database",
  headerActions,
  columnNote,
  columnEditing,
}: TableViewProps) => {
  const database = catalogue === "database";
  const { data: table, error, isLoading } = useTable(sourceId, tableId);
  const { tables: allTables, labelFor } = useAllTables(sourceId);
  const nameOf = (id: string) =>
    database ? labelFor(id) : (allTables.find((t) => t.id === id)?.name ?? id);
  const update = useUpdateTable(sourceId, tableId);

  const [view, setView] = useState<"columns" | "relations">("columns");
  const [params, setParams] = useState<FilterParams>({});
  const [editing, setEditing] = useState(false);
  const [tableText, setTableText] = useState("");
  // Each column's edited description, name and type, by id.
  const [columnText, setColumnText] = useState<Record<string, string>>({});
  const [columnName, setColumnName] = useState<Record<string, string>>({});
  const [columnType, setColumnType] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [columnError, setColumnError] = useState<ApiError | null>(null);
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
          <Link to={tablesHref}>All tables</Link>
        </p>
      </>
    );
  }

  const startEditing = () => {
    const original: Snapshot = {
      description: table.description ?? "",
      columns: Object.fromEntries(
        table.columns.map((c) => [
          c.id,
          { name: c.name, type: c.type, description: c.description ?? "" },
        ])
      ),
    };
    const each = (key: keyof ColumnState) =>
      Object.fromEntries(
        Object.entries(original.columns).map(([id, c]) => [id, c[key]])
      );
    setSnapshot(original);
    setTableText(original.description);
    setColumnText(each("description"));
    setColumnName(each("name"));
    setColumnType(each("type"));
    update.reset();
    setColumnError(null);
    setEditing(true);
  };

  /** The editable columns: those still in the table. */
  const editable = (id: string) =>
    !!columnEditing && !table.columns.find((c) => c.id === id)?.missing_since;
  const nameError = (id: string): string | undefined => {
    if (!columnEditing || !snapshot || !editable(id)) return undefined;
    const name = columnName[id] ?? "";
    if (name === snapshot.columns[id]?.name) return undefined;
    const problem = columnEditing.nameProblem(name);
    if (problem) return problem;
    return Object.keys(snapshot.columns).some(
      (other) =>
        other !== id &&
        (columnName[other] ?? snapshot.columns[other]!.name) === name
    )
      ? "Another column has this name."
      : undefined;
  };
  /** The columns whose name or type changed, with what changed. */
  const columnChanges = snapshot
    ? Object.entries(snapshot.columns).flatMap(([id, was]) => {
        if (!editable(id)) return [];
        const change: { name?: string; type?: string } = {
          ...(columnName[id] !== was.name && { name: columnName[id] }),
          ...(columnType[id] !== was.type && { type: columnType[id] }),
        };
        return Object.keys(change).length > 0 ? [{ id, change }] : [];
      })
    : [];
  const retyping = columnChanges.some((c) => c.change.type !== undefined);

  const overLimit =
    tooLong(tableText) || Object.values(columnText).some(tooLong);
  const badName = Object.keys(columnName).some((id) => !!nameError(id));

  const save = async () => {
    if (!snapshot) return;
    // What the server has is kept up to date as each step lands, so a
    // retry after a failure sends only what is left.
    const now: Snapshot = {
      description: snapshot.description,
      columns: { ...snapshot.columns },
    };
    setSaving(true);
    setColumnError(null);
    try {
      // Descriptions first: they name columns by the names they have now.
      const body: PatchTable = {};
      if (changed(tableText, now.description)) {
        body.description = sent(tableText);
      }
      const described = Object.entries(now.columns).filter(([id, c]) =>
        changed(columnText[id] ?? "", c.description)
      );
      if (described.length > 0) {
        body.columns = described.map(([id, c]) => ({
          name: c.name,
          description: sent(columnText[id] ?? ""),
        }));
      }
      if (Object.keys(body).length > 0) {
        try {
          await update.mutateAsync(body);
        } catch {
          return; // The mutation's error shows.
        }
        now.description = tableText.trim();
        for (const [id, c] of described) {
          now.columns[id] = { ...c, description: columnText[id]!.trim() };
        }
      }
      // Then each renamed or retyped column, one at a time.
      for (const { id, change } of columnChanges) {
        try {
          await columnEditing!.saveColumn(id, change);
        } catch (err) {
          setColumnError(err as ApiError);
          return;
        }
        now.columns[id] = { ...now.columns[id]!, ...change };
      }
      setEditing(false);
    } finally {
      setSnapshot(now);
      setSaving(false);
    }
  };

  const shownColumns = table.columns.filter((c) => columnMatches(c, params));

  const inEdit = (column: Column) =>
    editing && !!snapshot && column.id in snapshot.columns;

  const columnCells = (column: Column) =>
    inEdit(column) ? (
      <Input
        aria-label={`Description of column ${column.name}`}
        value={columnText[column.id] ?? ""}
        error={
          tooLong(columnText[column.id] ?? "") ? (
            <Counter text={columnText[column.id]!} />
          ) : undefined
        }
        helperText={
          tooLong(columnText[column.id] ?? "") ? undefined : (
            <Counter text={columnText[column.id] ?? ""} />
          )
        }
        onChange={(e) =>
          setColumnText((t) => ({ ...t, [column.id]: e.target.value }))
        }
      />
    ) : (
      (column.description ?? "")
    );

  const nameCell = (column: Column) =>
    inEdit(column) && editable(column.id) ? (
      <span className="z-column-edit">
        <Input
          label={`Name of column ${column.name}`}
          value={columnName[column.id] ?? ""}
          error={nameError(column.id)}
          onChange={(e) =>
            setColumnName((n) => ({ ...n, [column.id]: e.target.value }))
          }
        />
        {columnNote?.(column)}
      </span>
    ) : (
      <span className="z-tables-name">
        {column.name}
        {columnNote?.(column)}
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
    );

  const typeCell = (column: Column) =>
    inEdit(column) && editable(column.id) && columnEditing ? (
      <SearchSelect<ColumnTypeChoice>
        label={`Type of column ${column.name}`}
        value={
          columnEditing.types.find((t) => t.id === columnType[column.id]) ??
          null
        }
        options={columnEditing.types}
        getOptionLabel={(t) => t.label}
        getOptionKey={(t) => t.id}
        onSelect={(t) => setColumnType((ts) => ({ ...ts, [column.id]: t.id }))}
      />
    ) : (
      <span className="z-column-type">
        {column.type}
        {database && column.native_type !== column.type && (
          <code className="z-muted" title="Type in the database">
            {column.native_type}
          </code>
        )}
      </span>
    );

  const actions =
    canEdit || headerActions ? (
      <div className="z-header-actions">
        {!canEdit ? null : editing ? (
          <>
            <Button
              size="sm"
              variant="secondary"
              fullWidth={false}
              disabled={saving}
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              fullWidth={false}
              isLoading={saving}
              disabled={saving || overLimit || badName}
              onClick={() => void save()}
            >
              Save
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            fullWidth={false}
            onClick={startEditing}
          >
            {columnEditing ? "Edit columns" : "Edit descriptions"}
          </Button>
        )}
        {!editing && headerActions}
      </div>
    ) : undefined;

  return (
    <>
      <Link className="z-muted-link z-back-link" to={tablesHref}>
        ← All tables
      </Link>
      <div className="z-source-header z-table-header">
        <PageHeader
          title={database ? tableLabel(table) : table.name}
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
        {editing && columnError && columnEditing?.failure(columnError)}
        {editing && retyping && (
          <Alert variant="warning">{columnEditing?.retypeWarning}</Alert>
        )}
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
          <div
            className={`z-wrap z-columns-list${editing && columnEditing ? " z-columns-editing" : ""}`}
          >
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
                { title: "Name", cellElement: nameCell },
                { title: "Type", cellElement: typeCell },
                ...(database
                  ? [
                      {
                        title: "Nullable",
                        cellElement: (column: Column) => (
                          <YesNo value={column.nullable} />
                        ),
                      },
                    ]
                  : []),
                {
                  title: "Description",
                  // An upload source's few short columns: the description takes
                  // the spare width, the type and the action their content's.
                  ...(!database && { width: "100%" }),
                  cellElement: columnCells,
                },
              ]}
              rows={shownColumns}
            />
          </div>
        </>
      ) : (
        <>
          <div className="z-list-toolbar z-list-toolbar-end">
            <Link className="z-muted-link" to={relationsHref}>
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
                  cellElement: (relation) => nameOf(relation.to_table_id),
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
