import { useAllTables, type Table } from "@/features/tables";
import { useSourceContext } from "../../components/context";
import { sourceHref } from "../../components/sourceLabels";
import { ErrorNotice } from "@/components/ErrorNotice";
import { When } from "../../components/Facts";
import { Link } from "react-router-dom";
import "./styles.css";
import {
  Badge,
  EmptyState,
  Spinner,
  Table as DataTable,
} from "@kosmeo-ui/react";

/** One file or spreadsheet a source draws from, with the tables made from it. */
export interface UploadOrigin {
  key: string;
  name: string;
  /** A spreadsheet's link; a file has none. */
  url?: string;
  kind: "Google Sheet" | "CSV" | "Excel" | "File";
  tables: { id: string; name: string; tab?: string }[];
  /** The latest load of any of its tables. */
  lastLoadedAt: string | null;
  failing: number;
}

const fileKind = (filename: string): UploadOrigin["kind"] => {
  const ext = filename.toLowerCase().split(".").pop();
  return ext === "csv" ? "CSV" : ext === "xlsx" ? "Excel" : "File";
};

const later = (a: string | null, b: string | null) =>
  a === null ? b : b === null ? a : a > b ? a : b;

/**
 * The files and spreadsheets behind a source's tables, in the order their
 * first table comes: a spreadsheet by its id, a file by its name. A merged
 * table comes from the source's own tables, not an upload, and is left out.
 */
export const uploadOrigins = (tables: Table[]): UploadOrigin[] => {
  const byKey = new Map<string, UploadOrigin>();
  for (const t of tables) {
    const o = t.origin;
    if (o?.kind !== "file" && o?.kind !== "google-sheets") continue;
    const key =
      o.kind === "file" ? `file:${o.filename}` : `sheet:${o.spreadsheet_id}`;
    let origin = byKey.get(key);
    if (!origin) {
      origin = {
        key,
        ...(o.kind === "file"
          ? { name: o.filename, kind: fileKind(o.filename) }
          : {
              name: o.spreadsheet_title,
              // The spreadsheet, not one tab.
              url: o.url.replace(/#gid=\d+$/, ""),
              kind: "Google Sheet" as const,
            }),
        tables: [],
        lastLoadedAt: null,
        failing: 0,
      };
      byKey.set(key, origin);
    }
    origin.tables.push({ id: t.id, name: t.name, tab: o.tab_title });
    origin.lastLoadedAt = later(origin.lastLoadedAt, t.last_loaded_at);
    if (t.sync_error) origin.failing += 1;
  }
  return [...byKey.values()];
};

/** Upload Sources: the CSV and Excel files and Google Sheets an upload's tables come from. */
export const UploadOriginsPage = () => {
  const { source } = useSourceContext();
  const { tables, isLoading, error } = useAllTables(source.id, {
    includeMissing: false,
  });
  const base = sourceHref(source.id);
  if (isLoading) return <Spinner size="lg" />;
  return (
    <div className="z-wrap">
      <ErrorNotice error={error} />
      <DataTable<UploadOrigin>
        rowKey={(o) => o.key}
        emptyMessage={
          error ? undefined : (
            <EmptyState>No files or Google Sheets.</EmptyState>
          )
        }
        columns={[
          {
            title: "Name",
            minWidth: "14rem",
            cellElement: (o) =>
              o.url ? (
                <a href={o.url} target="_blank" rel="noopener noreferrer">
                  {o.name}
                </a>
              ) : (
                o.name
              ),
          },
          {
            title: "Type",
            minWidth: "7rem",
            cellElement: (o) => <span className="z-fs-nowrap">{o.kind}</span>,
          },
          {
            title: "Tables",
            width: "100%",
            cellElement: (o) => (
              <ul className="z-fs-origin-tables">
                {o.tables.map((t) => (
                  <li key={t.id}>
                    <Link to={`${base}/tables/${t.id}`}>{t.name}</Link>
                    {t.tab && <span className="z-muted"> · {t.tab}</span>}
                  </li>
                ))}
              </ul>
            ),
          },
          {
            title: "Last loaded",
            minWidth: "9rem",
            cellElement: (o) => (
              <span className="z-fs-nowrap">
                <When iso={o.lastLoadedAt} />
              </span>
            ),
          },
          {
            title: "Status",
            minWidth: "7rem",
            cellElement: (o) =>
              o.failing > 0 ? (
                <Badge size="sm" variant="danger">
                  {o.failing === 1 ? "Sync failing" : `${o.failing} failing`}
                </Badge>
              ) : o.kind === "Google Sheet" ? (
                <Badge size="sm" variant="success">
                  Syncing
                </Badge>
              ) : (
                <span className="z-muted">—</span>
              ),
          },
        ]}
        rows={uploadOrigins(tables)}
      />
    </div>
  );
};
