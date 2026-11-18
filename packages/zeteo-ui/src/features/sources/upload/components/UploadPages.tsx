import { Facts, LimitSections, When, type Row } from "../../components/Facts";
import { ColumnTypeDialog, type EditedColumn } from "./ColumnTypeDialog";
import { useSourceContext } from "../../components/context";
import { faTrash } from "@fortawesome/free-solid-svg-icons";
import { sourceHref } from "../../components/sourceLabels";
import { ConfirmButton } from "@/components/ConfirmButton";
import { BorderedSection, Button } from "@kosmeo-ui/react";
import { PrincipalLabel } from "@/features/principals";
import { EditButton } from "@/components/EditButton";
import { useRemoveTable } from "../api/uploads";
import { useNavigate } from "react-router-dom";
import { formatBytes } from "./labels";
import { useState } from "react";
import "./styles.css";
import {
  TableView,
  TablesList,
  useAllTables,
  useTable,
} from "@/features/tables";

/** An upload's overview: its data and owner, and its limits, laid out as a database source's. */
export const UploadOverview = () => {
  const { source, access } = useSourceContext();
  const { tables } = useAllTables(source.id, { includeMissing: false });
  return (
    <div className="z-source-overview">
      <div className="z-source-column">
        <LimitSections source={source} />
      </div>
      <div className="z-source-column">
        <BorderedSection title="Data" as="h2">
          <Facts
            rows={[
              [
                "Owner",
                access.isOwner ? (
                  "You"
                ) : source.owner_id ? (
                  <PrincipalLabel
                    refValue={{ type: "user", id: source.owner_id }}
                  />
                ) : (
                  "—"
                ),
              ],
              [
                "Size",
                source.size_bytes === null
                  ? "—"
                  : formatBytes(source.size_bytes),
              ],
              ["Tables", tables.length.toLocaleString()],
              ["Added", <When iso={source.created_at} />],
              ...(source.archived_at
                ? [["Deleted", <When iso={source.archived_at} />] as Row]
                : []),
            ]}
          />
        </BorderedSection>
      </div>
    </div>
  );
};

/** An upload's tables: the database source's list, with each table's rows and last load. */
export const UploadTables = () => {
  const { source, access } = useSourceContext();
  return (
    <TablesList
      sourceId={source.id}
      canEdit={access.canManage}
      catalogue="upload"
      tableHref={(id) => `${sourceHref(source.id)}/tables/${id}`}
      extraColumns={[
        {
          title: "Rows",
          minWidth: "5rem",
          align: "right",
          cellElement: (t) => t.row_count?.toLocaleString() ?? "—",
        },
        {
          title: "Last loaded",
          minWidth: "9rem",
          cellElement: (t) => (
            <span className="z-fs-nowrap">
              <When iso={t.last_loaded_at} />
            </span>
          ),
        },
      ]}
    />
  );
};

/** An upload table's own actions, beside the table page's "Edit descriptions". */
const TableActions = ({
  sourceId,
  tableId,
}: {
  sourceId: string;
  tableId: string;
}) => {
  const navigate = useNavigate();
  const remove = useRemoveTable(sourceId);
  const { data: table } = useTable(sourceId, tableId);
  const { tables } = useAllTables(sourceId, { includeMissing: false });
  const base = sourceHref(sourceId);
  if (!table || table.missing_since) return null;
  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        fullWidth={false}
        onClick={() => navigate(`${base}/tables/${table.id}/reupload`)}
      >
        Re-upload
      </Button>
      {tables.length > 1 && (
        <ConfirmButton
          danger
          size="sm"
          icon={faTrash}
          label={`Remove ${table.name}`}
          confirmTitle="Remove table"
          confirmText={`Remove ${table.name} and its data? Grants on it stay but give no access, and saved queries using it stop working.`}
          confirmLabel="Remove table"
          onConfirm={async () => {
            await remove.mutateAsync(table.id);
            navigate(`${base}/tables`);
          }}
        />
      )}
    </>
  );
};

/** One upload table: the database source's table page, with re-upload, removal and retyping. */
export const UploadTablePage = ({ tableId }: { tableId: string }) => {
  const { source, access } = useSourceContext();
  const [column, setColumn] = useState<EditedColumn | null>(null);
  const base = sourceHref(source.id);
  return (
    <>
      <TableView
        key={tableId}
        sourceId={source.id}
        tableId={tableId}
        canEdit={access.canManage}
        catalogue="upload"
        tablesHref={`${base}/tables`}
        relationsHref={`${base}/relations`}
        headerActions={
          access.canManage && (
            <TableActions sourceId={source.id} tableId={tableId} />
          )
        }
        columnNote={(c) =>
          c.original_name &&
          c.original_name !== c.name && (
            <span className="z-muted" title="Header in the file">
              {c.original_name}
            </span>
          )
        }
        columnAction={
          access.canManage
            ? (c) =>
                !c.missing_since && <EditButton onClick={() => setColumn(c)} />
            : undefined
        }
      />
      {column && (
        <ColumnTypeDialog
          sourceId={source.id}
          tableId={tableId}
          column={column}
          onClose={() => setColumn(null)}
        />
      )}
    </>
  );
};
