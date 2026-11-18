import { useCanEditCatalogue } from "../api/useCanEditCatalogue";
import { ErrorNotice } from "@/components/ErrorNotice";
import { useAllTables } from "../api/useAllTables";
import { useUuidParam } from "@/lib/useUuidParam";
import { NotFound } from "@/components/NotFound";
import { useMemo, useState } from "react";
import type { Table } from "../api/types";
import { Link } from "react-router-dom";
import "./styles.css";
import {
  Badge,
  EmptyState,
  Spinner,
  Switch,
  Table as DataTable,
  TableCellLink,
  TableFilters,
  type InfiniteScrollMenuFilter,
  type TableColumn,
} from "@kosmeo-ui/react";

export const TablesPage = () => {
  const sourceId = useUuidParam("sourceId");
  return sourceId ? <DatabaseTables sourceId={sourceId} /> : <NotFound />;
};

const DatabaseTables = ({ sourceId }: { sourceId: string }) => (
  <TablesList
    sourceId={sourceId}
    canEdit={useCanEditCatalogue(sourceId)}
    tableHref={(id) => `/sources/${sourceId}/tables/${id}`}
  />
);

export interface TablesListProps {
  sourceId: string;
  /** Whether the caller may describe the tables. */
  canEdit: boolean;
  tableHref: (tableId: string) => string;
  /** `upload`: a file source, whose tables have no schema or views to tell apart. */
  catalogue?: "database" | "upload";
  /** Columns after the description, for what only this kind of source has. */
  extraColumns?: TableColumn<Table>[];
}

/** Filter params as TableFilters reports them: `filter[name]`, `filter[schema_name]`, `filter[kind]`. */
type FilterParams = Record<string, string>;

const matches = (table: Table, params: FilterParams): boolean => {
  const name = params["filter[name]"]?.toLowerCase();
  if (name && !table.name.toLowerCase().includes(name)) return false;
  const schemas = params["filter[schema_name]"]?.split(",");
  if (schemas && !schemas.includes(table.schema_name)) return false;
  const kinds = params["filter[kind]"]?.split(",");
  if (kinds && !kinds.includes(table.kind)) return false;
  return true;
};

/** The schema and kind filters, which only a database source has use for. */
const databaseFilters = (schemaKey: string): InfiniteScrollMenuFilter[] => [
  {
    type: "SELECT",
    title: "Schema",
    dataKey: "schema_name",
    multiSelect: true,
    options: (schemaKey ? schemaKey.split(",") : []).map((s) => ({
      id: s,
      name: s,
      selected: false,
    })),
  },
  {
    type: "SELECT",
    title: "Kind",
    dataKey: "kind",
    options: [
      { id: "table", name: "Tables", selected: false },
      { id: "view", name: "Views", selected: false },
    ],
  },
];

/** A source's tables: the Tables tab of a database source, and of a file source. */
export const TablesList = ({
  sourceId,
  canEdit,
  tableHref,
  catalogue = "database",
  extraColumns = [],
}: TablesListProps) => {
  const database = catalogue === "database";
  const [includeMissing, setIncludeMissing] = useState(false);
  const [params, setParams] = useState<FilterParams>({});
  const { tables, isLoading, error } = useAllTables(sourceId, {
    includeMissing,
  });

  // A stable key, so the filter definitions (and their applied values) only
  // reset when the set of schemas really changes.
  const schemaKey = [...new Set(tables.map((t) => t.schema_name))]
    .sort()
    .join(",");
  const filters = useMemo<InfiniteScrollMenuFilter[]>(
    () => [
      { type: "SEARCH", title: "Name", dataKey: "name" },
      ...(database ? databaseFilters(schemaKey) : []),
    ],
    [schemaKey, database]
  );

  const shown = tables.filter((t) => matches(t, params));

  return (
    <>
      <div className="z-list-toolbar">
        <div className="z-list-toolbar-filters">
          <TableFilters filters={filters} onChange={setParams} />
        </div>
        <div className="z-list-toolbar-side">
          <Switch
            size="sm"
            label="Show missing"
            checked={includeMissing}
            onChange={(e) => setIncludeMissing(e.target.checked)}
          />
        </div>
      </div>
      <ErrorNotice error={error} />
      {isLoading ? (
        <Spinner size="lg" />
      ) : (
        <div className="z-wrap z-tables-list">
          <DataTable<Table>
            rowKey={(table) => table.id}
            emptyMessage={
              error ? undefined : tables.length === 0 ? (
                <EmptyState>
                  No tables yet. Refresh the catalogue to read the source's
                  tables.
                </EmptyState>
              ) : (
                <EmptyState>No tables match these filters.</EmptyState>
              )
            }
            columns={[
              {
                title: "Name",
                cellElement: (table) => (
                  <span className="z-tables-name">
                    <TableCellLink as={Link} to={tableHref(table.id)}>
                      {table.name}
                    </TableCellLink>
                    {table.kind === "view" && (
                      <Badge size="sm" variant="secondary">
                        View
                      </Badge>
                    )}
                    {table.missing_since && (
                      <Badge size="sm" variant="warning">
                        Missing
                      </Badge>
                    )}
                  </span>
                ),
              },
              ...(database
                ? [{ title: "Schema", dataKey: "schema_name" as const }]
                : []),
              {
                title: "Description",
                // With extra columns after it, the description takes the
                // spare width and they stay as narrow as their content.
                ...(extraColumns.length > 0 && { width: "100%" }),
                cellElement: (table) =>
                  table.description ? (
                    table.description
                  ) : canEdit ? (
                    <Link className="z-muted-link" to={tableHref(table.id)}>
                      Add description
                    </Link>
                  ) : (
                    <span className="z-muted">—</span>
                  ),
              },
              ...extraColumns,
            ]}
            rows={shown}
          />
        </div>
      )}
    </>
  );
};
