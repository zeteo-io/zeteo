import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { RenameDialog, TransferDialog } from "./FileSourceDialogs";
import { faTrash } from "@fortawesome/free-solid-svg-icons";
import { ConfirmButton } from "@/components/ConfirmButton";
import { formatRelative } from "@/utils/formatRelative";
import { PrincipalLabel } from "@/features/principals";
import { ErrorNotice } from "@/components/ErrorNotice";
import { ColumnTypeDialog } from "./ColumnTypeDialog";
import { PageHeader } from "@/components/PageHeader";
import { EditButton } from "@/components/EditButton";
import { useUuidParam } from "@/lib/useUuidParam";
import "@/features/sources/components/styles.css";
import { NotFound } from "@/components/NotFound";
import { formatDate } from "@/utils/formatDate";
import { GrantsSection } from "./GrantsSection";
import { useAuth } from "@tereo-io/react";
import type { Me } from "@/lib/auth";
import { useState } from "react";
import "./styles.css";
import {
  useDeleteFileSource,
  useFileSource,
  useRemoveTable,
} from "../api/fileSources";
import {
  Badge,
  BorderedSection,
  Button,
  RowActions,
  Spinner,
  Table,
} from "@kosmeo-ui/react";
import type {
  FileSource,
  FileSourceColumn,
  FileSourceTable,
} from "../api/types";
import {
  columnTypeName,
  fileSourceHref,
  formatBytes,
  MY_DATA_HREF,
} from "./labels";

const TABS = [
  { id: "tables", label: "Tables" },
  { id: "sharing", label: "Shared with" },
] as const;
type Tab = (typeof TABS)[number]["id"];

const When = ({ iso, never }: { iso: string | null; never: string }) =>
  iso ? (
    <time dateTime={iso} title={formatDate(iso)}>
      {formatRelative(iso)}
    </time>
  ) : (
    <span className="z-muted">{never}</span>
  );

export const FileSourcePage = () => {
  const id = useUuidParam("fileSourceId");
  return id ? <FileSourceLoader key={id} id={id} /> : <NotFound />;
};

const FileSourceLoader = ({ id }: { id: string }) => {
  const { data, error, isLoading } = useFileSource(id);
  if (isLoading) return <Spinner size="lg" />;
  if (!data) {
    return (
      <>
        <ErrorNotice error={error} />
        <p>
          <Link to={MY_DATA_HREF}>My data</Link>
        </p>
      </>
    );
  }
  return <FileSourceView source={data} />;
};

interface TableSectionProps {
  source: FileSource;
  table: FileSourceTable;
  canManage: boolean;
  onEditColumn: (column: FileSourceColumn) => void;
}

const TableSection = ({
  source,
  table,
  canManage,
  onEditColumn,
}: TableSectionProps) => {
  const navigate = useNavigate();
  const remove = useRemoveTable(source.id);
  const columns = table.columns.filter((c) => !c.missing);
  const live = source.tables.filter((t) => !t.missing);
  return (
    <BorderedSection
      title={table.name}
      as="h2"
      actions={
        canManage && (
          <div className="z-header-actions">
            <Button
              size="sm"
              variant="secondary"
              fullWidth={false}
              onClick={() =>
                navigate(
                  `${fileSourceHref(source.id)}/tables/${table.id}/reupload`
                )
              }
            >
              Re-upload
            </Button>
            {live.length > 1 && (
              <ConfirmButton
                danger
                size="sm"
                icon={faTrash}
                label={`Remove ${table.name}`}
                confirmTitle="Remove table"
                confirmText={`Remove ${table.name} and its data? Grants on it stay but give no access, and saved queries using it stop working.`}
                confirmLabel="Remove table"
                onConfirm={() => remove.mutateAsync(table.id)}
              />
            )}
          </div>
        )
      }
    >
      <p className="z-fs-table-meta">
        <span>{table.row_count.toLocaleString()} rows</span>
        <span>
          Loaded <When iso={table.last_synced_at} never="never" />
        </span>
      </p>
      <div className={canManage ? "z-actions-last" : undefined}>
        <Table<FileSourceColumn>
          rowKey={(c) => c.id}
          rows={columns}
          columns={[
            {
              title: "Column",
              cellElement: (c) => (
                <span className="z-sources-name">
                  <code>{c.name}</code>
                  {c.original_name && c.original_name !== c.name && (
                    <span className="z-muted">{c.original_name}</span>
                  )}
                </span>
              ),
            },
            {
              title: "Type",
              cellElement: (c) => columnTypeName(c.type),
            },
            {
              title: "Description",
              cellElement: (c) =>
                c.description ? (
                  c.description
                ) : canManage ? (
                  <button
                    type="button"
                    className="z-fs-add-description"
                    onClick={() => onEditColumn(c)}
                  >
                    Add description
                  </button>
                ) : (
                  <span className="z-muted">—</span>
                ),
            },
            ...(canManage
              ? [
                  {
                    title: "",
                    cellElement: (c: FileSourceColumn) => (
                      <RowActions align="end">
                        <EditButton onClick={() => onEditColumn(c)} />
                      </RowActions>
                    ),
                  },
                ]
              : []),
          ]}
        />
      </div>
    </BorderedSection>
  );
};

type Dialog =
  | { kind: "rename" }
  | { kind: "transfer" }
  | { kind: "column"; tableId: string; column: FileSourceColumn }
  | null;

const FileSourceView = ({ source }: { source: FileSource }) => {
  const { user, hasPermission } = useAuth<Me>();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const tab: Tab = params.get("tab") === "sharing" ? "sharing" : "tables";
  const remove = useDeleteFileSource();
  const [dialog, setDialog] = useState<Dialog>(null);
  const close = () => setDialog(null);

  const isOwner = !!user && source.owner_id === user.id;
  const archived = !!source.archived_at;
  // The owner while they hold the permission, or an admin who changes sources.
  const canManage =
    !archived &&
    ((isOwner && hasPermission("zeteo.file_sources.write")) ||
      hasPermission("zeteo.sources.write"));
  const tables = source.tables.filter((t) => !t.missing);
  const back = isOwner ? MY_DATA_HREF : "/sources";

  const actions = canManage && (
    <div className="z-header-actions">
      <Button
        size="sm"
        variant="secondary"
        fullWidth={false}
        onClick={() => navigate(`${fileSourceHref(source.id)}/add`)}
      >
        Add tables
      </Button>
      <Button
        size="sm"
        variant="secondary"
        fullWidth={false}
        onClick={() => setDialog({ kind: "rename" })}
      >
        Rename
      </Button>
      <Button
        size="sm"
        variant="secondary"
        fullWidth={false}
        onClick={() => setDialog({ kind: "transfer" })}
      >
        Transfer
      </Button>
      <ConfirmButton
        label="Delete"
        size="sm"
        danger
        confirmTitle="Delete source"
        confirmText={`Delete "${source.name}" and all its data? Zeteo holds the only copy, so it cannot be recovered. Saved queries and dashboards using it stop working.`}
        confirmLabel="Delete source"
        onConfirm={async () => {
          await remove.mutateAsync(source.id);
          navigate(back);
        }}
      />
    </div>
  );

  return (
    <>
      <Link className="z-muted-link z-back-link" to={back}>
        ← {isOwner ? "My data" : "Sources"}
      </Link>
      <div className="z-source-header">
        <PageHeader
          title={source.name}
          badges={
            <span className="z-source-subtitle">
              <code>{source.slug}</code>
              <span>Upload</span>
              {archived && (
                <Badge size="sm" variant="secondary">
                  Deleted
                </Badge>
              )}
            </span>
          }
          actions={actions}
          divider={false}
        />
      </div>
      <p className="z-fs-facts">
        <span>
          Owner{" "}
          {isOwner ? (
            "you"
          ) : (
            <PrincipalLabel refValue={{ type: "user", id: source.owner_id }} />
          )}
        </span>
        <span>{formatBytes(source.stored_bytes)} stored</span>
        <span>
          Created <When iso={source.created_at} never="—" />
        </span>
      </p>
      <nav className="z-source-tabs" aria-label="File source">
        {TABS.map((t) => (
          <Link
            key={t.id}
            to={
              t.id === "tables"
                ? fileSourceHref(source.id)
                : `${fileSourceHref(source.id)}?tab=${t.id}`
            }
            className={`z-source-tab${t.id === tab ? " active" : ""}`}
            aria-current={t.id === tab ? "page" : undefined}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {tab === "tables" && (
        <div className="z-fs-tables">
          {tables.length === 0 && (
            <p className="z-note">This source has no tables.</p>
          )}
          {tables.map((t) => (
            <TableSection
              key={t.id}
              source={source}
              table={t}
              canManage={canManage}
              onEditColumn={(column) =>
                setDialog({ kind: "column", tableId: t.id, column })
              }
            />
          ))}
        </div>
      )}
      {tab === "sharing" && (
        <GrantsSection source={source} canManage={canManage} />
      )}

      {dialog?.kind === "rename" && (
        <RenameDialog source={source} onClose={close} />
      )}
      {dialog?.kind === "transfer" && (
        <TransferDialog
          source={source}
          onClose={close}
          onDone={() => isOwner && navigate(MY_DATA_HREF)}
        />
      )}
      {dialog?.kind === "column" && (
        <ColumnTypeDialog
          sourceId={source.id}
          tableId={dialog.tableId}
          column={dialog.column}
          onClose={close}
        />
      )}
    </>
  );
};
