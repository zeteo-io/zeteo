import { Alert, Badge, BorderedSection, Button } from "@kosmeo-ui/react";
import type { MergedDetail as Merged } from "@/features/tables";
import { useNavigate } from "react-router-dom";

interface Props {
  sourceId: string;
  tableId: string;
  merged: Merged;
  /** Whether the caller may change the table's definition. */
  canEdit: boolean;
}

const inOf = (have: number, all: number) => `${have} of ${all}`;

/** A merged table's definition on its table page: members, columns, what could be added, and what gives NULL. */
export const MergedDetail = ({ sourceId, tableId, merged, canEdit }: Props) => {
  const navigate = useNavigate();
  const nameOfMember = (id: string) =>
    merged.members.find((m) => m.table_id === id)?.name ?? id;
  const nameOfColumn = (id: string) =>
    merged.columns.find((c) => c.id === id)?.name ?? id;
  const live = merged.members.filter((m) => !m.missing).length;
  return (
    <div className="z-merged-detail">
      <BorderedSection
        title="Merged from"
        as="h2"
        actions={
          canEdit && (
            <Button
              size="sm"
              variant="secondary"
              fullWidth={false}
              onClick={() =>
                navigate(`/sources/${sourceId}/tables/${tableId}/merged/edit`)
              }
            >
              Edit
            </Button>
          )
        }
      >
        <p className="z-note">
          Each row carries its member&apos;s label in{" "}
          <code>{merged.label_column}</code>.
        </p>
        <table className="z-merged-table">
          <thead>
            <tr>
              <th>Table</th>
              <th>Label</th>
            </tr>
          </thead>
          <tbody>
            {merged.members.map((m) => (
              <tr key={m.table_id}>
                <td>
                  <span className="z-tables-name">
                    {m.name}
                    {m.missing && (
                      <Badge size="sm" variant="warning">
                        Missing
                      </Badge>
                    )}
                  </span>
                </td>
                <td>{m.label}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </BorderedSection>

      {merged.warnings.length > 0 && (
        <Alert variant="warning">
          {merged.warnings.map((w) => (
            <p key={`${w.column_id}:${w.table_id}`}>
              {`Column ${nameOfColumn(w.column_id)}: no usable value from ${nameOfMember(w.table_id)}; its rows are empty there.`}
            </p>
          ))}
        </Alert>
      )}

      <BorderedSection title="Columns" as="h2">
        <table className="z-merged-table">
          <thead>
            <tr>
              <th>Column</th>
              <th>In</th>
              <th>Type</th>
            </tr>
          </thead>
          <tbody>
            {merged.columns.map((c) => (
              <tr key={c.id}>
                <td>
                  <span className="z-tables-name">
                    {c.name}
                    {c.missing && (
                      <Badge size="sm" variant="warning">
                        Missing
                      </Badge>
                    )}
                  </span>
                </td>
                <td>{inOf(c.members.length, live)}</td>
                <td>{c.type}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </BorderedSection>

      {merged.available.length > 0 && (
        <BorderedSection title="Available columns" as="h2">
          <p className="z-note">
            Columns the members have that this table does not carry. Edit the
            table to add them.
          </p>
          <table className="z-merged-table">
            <thead>
              <tr>
                <th>Column</th>
                <th>In</th>
                <th>Type</th>
              </tr>
            </thead>
            <tbody>
              {merged.available.map((c) => (
                <tr key={c.name}>
                  <td>{c.name}</td>
                  <td>{inOf(c.members.length, live)}</td>
                  <td>{c.type}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </BorderedSection>
      )}
    </div>
  );
};
