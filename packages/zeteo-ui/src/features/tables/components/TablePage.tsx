import { useCanEditCatalogue } from "../api/useCanEditCatalogue";
import { tableLabel, useAllTables } from "../api/useAllTables";
import type { Relation } from "@/features/relations/api/types";
import { ErrorNotice } from "@/components/ErrorNotice";
import { useUpdateTable } from "../api/useUpdateTable";
import type { Column, PatchTable } from "../api/types";
import { PageHeader } from "@/components/PageHeader";
import { Link, useParams } from "react-router-dom";
import { useTable } from "../api/useTable";
import { useState } from "react";
import "./styles.css";
import {
  Badge,
  Button,
  EmptyState,
  Input,
  Spinner,
  Table as DataTable,
} from "@kosmeo-ui/react";

const MAX_DESCRIPTION = 2000;

const Counter = ({ text }: { text: string }) =>
  text.length > MAX_DESCRIPTION
    ? `${text.length} / ${MAX_DESCRIPTION}: at most ${MAX_DESCRIPTION} characters`
    : `${text.length} / ${MAX_DESCRIPTION}`;

const tooLong = (text: string) => text.length > MAX_DESCRIPTION;

/** What `PATCH` takes for a field: an emptied description clears it. */
const sent = (text: string) => (text === "" ? null : text);
const changed = (text: string, stored: string | null) =>
  text !== (stored ?? "");

const yesNo = (value: boolean) => (value ? "Yes" : "No");

export const TablePage = () => {
  const { sourceId = "", tableId = "" } = useParams();
  const { data: table, error, isLoading } = useTable(sourceId, tableId);
  const { labelFor } = useAllTables(sourceId);
  const canEdit = useCanEditCatalogue(sourceId);
  const update = useUpdateTable(sourceId, tableId);

  const [editing, setEditing] = useState(false);
  const [tableText, setTableText] = useState("");
  const [columnText, setColumnText] = useState<Record<string, string>>({});

  if (isLoading) return <Spinner size="lg" />;
  if (!table) return <ErrorNotice error={error} />;

  const startEditing = () => {
    setTableText(table.description ?? "");
    setColumnText(
      Object.fromEntries(
        table.columns.map((c) => [c.name, c.description ?? ""])
      )
    );
    update.reset();
    setEditing(true);
  };

  const overLimit =
    tooLong(tableText) || Object.values(columnText).some(tooLong);

  const save = () => {
    const body: PatchTable = {};
    if (changed(tableText, table.description)) {
      body.description = sent(tableText);
    }
    const columns = table.columns
      .filter((c) => changed(columnText[c.name] ?? "", c.description))
      .map((c) => ({ name: c.name, description: sent(columnText[c.name]) }));
    if (columns.length > 0) body.columns = columns;
    if (Object.keys(body).length === 0) {
      setEditing(false);
      return;
    }
    update.mutate(body, { onSuccess: () => setEditing(false) });
  };

  const columnCells = (column: Column) =>
    editing ? (
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

  return (
    <>
      <PageHeader
        title={tableLabel(table)}
        subtitle={table.kind === "view" ? "View" : "Table"}
        badges={
          table.missing_since ? (
            <Badge size="sm" variant="warning">
              Missing
            </Badge>
          ) : undefined
        }
      />
      <p>
        <Link to={`/sources/${sourceId}/tables`}>All tables</Link>
      </p>

      <section className="z-table-section">
        {canEdit && (
          <div className="z-table-actions">
            {editing ? (
              <>
                <Button
                  fullWidth={false}
                  isLoading={update.isPending}
                  disabled={update.isPending || overLimit}
                  onClick={save}
                >
                  Save
                </Button>
                <Button
                  variant="secondary"
                  fullWidth={false}
                  disabled={update.isPending}
                  onClick={() => setEditing(false)}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                variant="secondary"
                fullWidth={false}
                onClick={startEditing}
              >
                Edit descriptions
              </Button>
            )}
          </div>
        )}
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
          <p className="z-table-description">
            {table.description ?? "No description."}
          </p>
        )}
      </section>

      <section className="z-table-section">
        <h2>Columns</h2>
        <DataTable<Column>
          rowKey={(column) => column.id}
          emptyMessage={<EmptyState>No columns.</EmptyState>}
          columns={[
            {
              title: "Name",
              cellElement: (column) => (
                <>
                  {column.name}{" "}
                  <span className="z-table-badges">
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
                </>
              ),
            },
            { title: "Type", dataKey: "type" },
            { title: "Native type", dataKey: "native_type" },
            {
              title: "Nullable",
              cellElement: (column) => yesNo(column.nullable),
            },
            { title: "Description", cellElement: columnCells },
          ]}
          rows={table.columns}
        />
      </section>

      <section className="z-table-section">
        <h2>Relations</h2>
        <p>Manage relations on the source's Relations tab.</p>
        <DataTable<Relation>
          rowKey={(relation) => relation.id}
          emptyMessage={
            <EmptyState>No relations start at this table.</EmptyState>
          }
          columns={[
            {
              title: "Name",
              cellElement: (relation) => (
                <>
                  {relation.name}{" "}
                  {relation.missing_since && (
                    <Badge size="sm" variant="warning">
                      Missing
                    </Badge>
                  )}
                </>
              ),
            },
            {
              title: "To table",
              cellElement: (relation) => labelFor(relation.to_table_id),
            },
            {
              title: "Columns",
              cellElement: (relation) =>
                relation.from_columns
                  .map((c, i) => `${c} → ${relation.to_columns[i]}`)
                  .join(", "),
            },
            {
              title: "To many",
              cellElement: (relation) => yesNo(relation.to_many),
            },
            { title: "Origin", dataKey: "origin" },
          ]}
          rows={table.relations}
        />
      </section>
    </>
  );
};
