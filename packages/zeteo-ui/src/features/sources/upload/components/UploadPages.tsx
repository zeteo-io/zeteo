import { Facts, LimitSections, When, type Row } from "../../components/Facts";
import { Badge, BorderedSection, Button, Tooltip } from "@kosmeo-ui/react";
import { FILE_COLUMN_TYPES, type UpdateColumn } from "../api/types";
import { useRemoveTable, useUpdateColumn } from "../api/uploads";
import { useSourceContext } from "../../components/context";
import { faTrash } from "@fortawesome/free-solid-svg-icons";
import { sourceHref } from "../../components/sourceLabels";
import { ConfirmButton } from "@/components/ConfirmButton";
import { useLayoutEffect, useRef, useState } from "react";
import { columnTypeName, RETYPE_WARNING } from "./labels";
import { PrincipalLabel } from "@/features/principals";
import { LoadFailure } from "./CastFailedNotice";
import { nameProblem } from "@/utils/queryName";
import { useNavigate } from "react-router-dom";
import { MergedDetail } from "./MergedDetail";
import type { Source } from "../../api/types";
import { formatBytes } from "./labels";
import "./styles.css";
import {
  TableView,
  TablesList,
  useAllTables,
  useTable,
  type ColumnEditing,
  type Table,
} from "@/features/tables";

/** A sync interval in words: 60 → "Every hour", 90 → "Every 90 minutes". */
export const intervalName = (minutes: number): string =>
  minutes === 60
    ? "Every hour"
    : minutes % 60 === 0
      ? `Every ${minutes / 60} hours`
      : `Every ${minutes} minutes`;

/** The spreadsheets a source draws from, with its sync state, as its owner or a sources reader sees them. */
const SheetsBlock = ({
  source,
  tables,
}: {
  source: Source;
  tables: Table[];
}) => {
  const { sync } = source;
  const failingIds = new Set(sync?.failing.map((f) => f.table_id));
  const sheets = new Map<
    string,
    { title: string; url: string; tabs: number; failing: number }
  >();
  for (const t of tables) {
    if (t.origin?.kind !== "google-sheets") continue;
    const entry = sheets.get(t.origin.spreadsheet_id) ?? {
      title: t.origin.spreadsheet_title,
      url: t.origin.url,
      tabs: 0,
      failing: 0,
    };
    entry.tabs += 1;
    if (t.sync_error || failingIds.has(t.id)) entry.failing += 1;
    sheets.set(t.origin.spreadsheet_id, entry);
  }
  if (sheets.size === 0) return null;
  return (
    <BorderedSection title="Google Sheets" as="h2">
      <ul className="z-fs-sheets">
        {[...sheets.entries()].map(([id, s]) => (
          <li key={id}>
            <a
              href={s.url}
              target="_blank"
              rel="noreferrer"
              aria-label={`Open ${s.title} in Google Sheets`}
            >
              {s.title}
            </a>{" "}
            <span className="z-muted">
              {s.tabs} {s.tabs === 1 ? "tab" : "tabs"}
            </span>
            {s.failing > 0 && (
              <span className="z-fs-sync-error"> · {s.failing} failing</span>
            )}
          </li>
        ))}
      </ul>
      <Facts
        rows={[
          ...(sync
            ? [["Sync", intervalName(sync.interval_minutes)] as Row]
            : []),
          [
            "Last synced",
            source.last_refreshed_at ? (
              <When iso={source.last_refreshed_at} />
            ) : (
              "Not yet"
            ),
          ] as Row,
        ]}
      />
    </BorderedSection>
  );
};

/**
 * A tab's (or an xlsx sheet's) name on one line, at most 15rem wide: a longer
 * one ends in "…" and shows in full in a tooltip; one that fits has none.
 */
const OriginTab = ({ name }: { name: string }) => {
  const ref = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setCut(el.scrollWidth > el.clientWidth);
  }, [name]);
  return (
    <Tooltip
      disabled={!cut}
      content={<span className="z-wide-tip">{name}</span>}
    >
      <span ref={ref} className="z-fs-origin-tab">
        {name}
      </span>
    </Tooltip>
  );
};

/** Where a table came from: its file, its spreadsheet tab, or its members; and a failing sync. */
const OriginCell = ({ table }: { table: Table }) => {
  const { origin } = table;
  return (
    <span className="z-fs-origin">
      {origin?.kind === "file" ? (
        <span className="z-fs-origin-name">
          <Tooltip
            content={<span className="z-wide-tip">{origin.filename}</span>}
          >
            <span>File Upload</span>
          </Tooltip>
          {origin.tab_title && <OriginTab name={origin.tab_title} />}
        </span>
      ) : origin?.kind === "google-sheets" ? (
        <span className="z-fs-origin-name">
          <Tooltip
            content={
              <span className="z-wide-tip">{origin.spreadsheet_title}</span>
            }
          >
            <a href={origin.url} target="_blank" rel="noopener noreferrer">
              Google Sheet
            </a>
          </Tooltip>
          {origin.tab_title && <OriginTab name={origin.tab_title} />}
        </span>
      ) : origin?.kind === "merged" ? (
        `Merged · ${origin.members} ${origin.members === 1 ? "table" : "tables"}`
      ) : (
        <span className="z-muted">—</span>
      )}
      {table.sync_error && (
        <Tooltip
          content={
            <span className="z-wide-tip">
              {table.sync_error.message || table.sync_error.code}
            </span>
          }
        >
          <span>
            <Badge size="sm" variant="danger">
              Sync failing
            </Badge>
          </span>
        </Tooltip>
      )}
    </span>
  );
};

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
        <SheetsBlock source={source} tables={tables} />
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
          title: "Origin",
          minWidth: "10rem",
          cellElement: (t) => <OriginCell table={t} />,
        },
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
      {table.origin?.kind !== "google-sheets" && !table.merged && (
        <Button
          size="sm"
          variant="secondary"
          fullWidth={false}
          onClick={() => navigate(`${base}/tables/${table.id}/reupload`)}
        >
          Re-upload
        </Button>
      )}
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

const TYPE_CHOICES = FILE_COLUMN_TYPES.map((t) => ({
  id: t,
  label: columnTypeName(t),
}));

/** One upload table: the database source's table page, with re-upload, removal, renaming and retyping. */
export const UploadTablePage = ({ tableId }: { tableId: string }) => {
  const { source, access } = useSourceContext();
  const updateColumn = useUpdateColumn(source.id, tableId);
  const base = sourceHref(source.id);
  const { data: table } = useTable(source.id, tableId);
  const merged = table?.merged ?? null;
  const columnEditing: ColumnEditing = {
    types: TYPE_CHOICES,
    nameProblem,
    // A new type reloads the table from its stored values; a value that
    // does not fit fails it with the rows, and nothing changes.
    saveColumn: (columnId, change) =>
      updateColumn.mutateAsync({
        columnId,
        body: change as UpdateColumn,
      }),
    retypeWarning: `${RETYPE_WARNING} The table is reloaded with the new type; if a value does not fit, nothing changes.`,
    failure: (error) => <LoadFailure error={error} rowsOf="table" />,
  };
  return (
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
      // A merged table's columns come from its definition: edit it there.
      columnEditing={access.canManage && !merged ? columnEditing : undefined}
      aside={
        merged && (
          <MergedDetail
            sourceId={source.id}
            tableId={tableId}
            merged={merged}
            canEdit={access.canManage}
          />
        )
      }
    />
  );
};
