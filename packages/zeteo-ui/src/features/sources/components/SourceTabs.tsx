import { TableView, TablesList, useAllTables } from "@/features/tables";
import { UploadOriginsPage } from "../upload/components/UploadOrigins";
import { NoAccessSection } from "@/components/NoAccessSection";
import { isUploadType, sourceHref } from "./sourceLabels";
import { RelationsList } from "@/features/relations";
import { MeasuresTab } from "@/features/measures";
import { useUuidParam } from "@/lib/useUuidParam";
import { SourceGrants } from "@/features/grants";
import { NotFound } from "@/components/NotFound";
import { useSourceContext } from "./context";
import {
  UploadTablePage,
  UploadTables,
} from "../upload/components/UploadPages";

/** Tables: a database source's, or an upload's with its rows and loads. */
export const SourceTablesPage = () => {
  const { source, access } = useSourceContext();
  if (isUploadType(source.type)) return <UploadTables />;
  return (
    <TablesList
      sourceId={source.id}
      canEdit={access.canManage}
      tableHref={(id) => `${sourceHref(source.id)}/tables/${id}`}
      extraColumns={[
        {
          // The database's own statistics at the last refresh, not a count.
          title: "Rows (approx.)",
          minWidth: "9.5rem",
          align: "right",
          cellElement: (t) =>
            t.row_count === null ? (
              <span className="z-muted">—</span>
            ) : (
              t.row_count.toLocaleString()
            ),
        },
      ]}
    />
  );
};

/** One table: a database source's, or an upload's with re-upload and retyping. */
export const SourceTablePage = () => {
  const { source, access } = useSourceContext();
  const tableId = useUuidParam("tableId");
  if (!tableId) return <NotFound />;
  if (isUploadType(source.type)) return <UploadTablePage tableId={tableId} />;
  return (
    <TableView
      key={tableId}
      sourceId={source.id}
      tableId={tableId}
      canEdit={access.canManage}
      tablesHref={`${sourceHref(source.id)}/tables`}
      relationsHref={`${sourceHref(source.id)}/relations`}
    />
  );
};

/** Relations: an upload's tables are named without their schema. */
export const SourceRelationsPage = () => {
  const { source, access } = useSourceContext();
  return (
    <RelationsList
      sourceId={source.id}
      canEdit={access.canManage}
      catalogue={isUploadType(source.type) ? "upload" : "database"}
    />
  );
};

/** Shared with: every grant on the source's tables, an upload owner's own included. */
export const SourceSharingPage = () => {
  const { source, access } = useSourceContext();
  const upload = isUploadType(source.type);
  const { tables } = useAllTables(
    access.canSeeSharing ? source.id : undefined,
    {
      includeMissing: false,
    }
  );
  if (!access.canSeeSharing) {
    // An upload's sharing is its owner's business: not found to anyone else.
    return upload ? (
      <NotFound />
    ) : (
      <NoAccessSection permission="zeteo.grants.read" />
    );
  }
  // The schema names a table only where it tells tables apart.
  const showSchema =
    !upload && new Set(tables.map((t) => t.schema_name)).size > 1;
  return (
    <SourceGrants
      sourceId={source.id}
      tables={tables.map((t) => ({
        id: t.id,
        name: showSchema ? `${t.schema_name}.${t.name}` : t.name,
        missing: t.missing_since !== null,
      }))}
      canShare={access.canShare}
      canRemove={access.canRemoveGrants}
    />
  );
};

/** Upload Sources: only an upload source has one. */
export const SourceUploadsPage = () => {
  const { source } = useSourceContext();
  return isUploadType(source.type) ? <UploadOriginsPage /> : <NotFound />;
};

/** Measures: named calculations on a table; who writes them is `zeteo.measures.write`, who edits the editor list a sources admin or an upload's owner. */
export const SourceMeasuresPage = () => {
  const { source, access } = useSourceContext();
  return (
    <MeasuresTab
      sourceId={source.id}
      canWrite={access.canWriteMeasures}
      canManageEditors={access.canManageMeasureEditors}
    />
  );
};
