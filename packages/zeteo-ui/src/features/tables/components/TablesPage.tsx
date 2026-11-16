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
} from "@kosmeo-ui/react";

export const TablesPage = () => {
  const sourceId = useUuidParam("sourceId");
  return sourceId ? <TablesList sourceId={sourceId} /> : <NotFound />;
};

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

const TablesList = ({ sourceId }: { sourceId: string }) => {
  const [includeMissing, setIncludeMissing] = useState(false);
  const [params, setParams] = useState<FilterParams>({});
  const canEdit = useCanEditCatalogue(sourceId);
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
    ],
    [schemaKey]
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
                    <TableCellLink
                      as={Link}
                      to={`/sources/${sourceId}/tables/${table.id}`}
                    >
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
              { title: "Schema", dataKey: "schema_name" },
              {
                title: "Description",
                cellElement: (table) =>
                  table.description ? (
                    table.description
                  ) : canEdit ? (
                    <Link
                      className="z-muted-link"
                      to={`/sources/${sourceId}/tables/${table.id}`}
                    >
                      Add description
                    </Link>
                  ) : (
                    <span className="z-muted">—</span>
                  ),
              },
            ]}
            rows={shown}
          />
        </div>
      )}
    </>
  );
};
