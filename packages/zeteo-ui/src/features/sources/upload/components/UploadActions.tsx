import { useRefreshSource } from "../../api/useRefreshSource";
import type { SourceAccess } from "../../components/access";
import { sourceHref } from "../../components/sourceLabels";
import { ConfirmButton } from "@/components/ConfirmButton";
import type { Source, SyncSummary } from "../../api/types";
import { SourceForm } from "../../components/SourceForm";
import { useDeleteUploadSource } from "../api/uploads";
import { ErrorNotice } from "@/components/ErrorNotice";
import { TransferDialog } from "./TransferDialog";
import { Alert, Button } from "@kosmeo-ui/react";
import { useAllTables } from "@/features/tables";
import { useNavigate } from "react-router-dom";
import type { ApiError } from "@/lib/api";
import { MY_DATA_HREF } from "./labels";
import { useState } from "react";

const tablesSynced = (summary: SyncSummary) => {
  const live = summary.tables.filter((t) => !t.missing);
  const failing = live.filter((t) => t.error).length;
  const n = live.length;
  const synced = `Synced ${n} ${n === 1 ? "table" : "tables"}`;
  return failing > 0 ? `${synced}; ${failing} failing` : synced;
};

/**
 * An upload's header actions (Sync now for a source with Google Sheets tables, Add tables, Add merged table, Transfer, Edit, Delete) and the
 * dialogs they open: for its owner or a sources admin, until it is deleted.
 */
export const useUploadActions = (source: Source, access: SourceAccess) => {
  const navigate = useNavigate();
  const remove = useDeleteUploadSource();
  const [dialog, setDialog] = useState<"edit" | "transfer" | null>(null);
  const close = () => setDialog(null);
  const refresh = useRefreshSource(source.id);
  const { tables: all } = useAllTables(source.id);
  const tables = all.filter((t) => t.missing_since === null);
  // The server syncs a source that has any Sheets table not removed, live or
  // missing (a restored tab revives its table); a removed table is missing
  // too, and `sync` is on the source exactly when one is not removed.
  const sheets = all.filter((t) => t.origin?.kind === "google-sheets");
  const hasSheets =
    sheets.some((t) => t.missing_since === null) ||
    (sheets.length > 0 && source.sync !== undefined);
  const canMerge =
    !source.archived_at &&
    tables.filter((t) => t.origin?.kind !== "merged").length >= 2;
  const [synced, setSynced] = useState<SyncSummary | null>(null);
  const [syncError, setSyncError] = useState<ApiError | null>(null);

  const syncNow = () => {
    if (refresh.isPending) return;
    setSynced(null);
    setSyncError(null);
    refresh.mutate(undefined, {
      // For a source with Sheets tables the server answers with what it synced.
      onSuccess: (result) => "synced_at" in result && setSynced(result),
      onError: setSyncError,
    });
  };

  const actions = access.canManage && (
    <div className="z-source-actions">
      {hasSheets && (
        <Button
          size="sm"
          variant="secondary"
          fullWidth={false}
          isLoading={refresh.isPending}
          disabled={refresh.isPending}
          onClick={syncNow}
        >
          Sync now
        </Button>
      )}
      <Button
        size="sm"
        variant="secondary"
        fullWidth={false}
        onClick={() => navigate(`${sourceHref(source.id)}/add`)}
      >
        Add tables
      </Button>
      {canMerge && (
        <Button
          size="sm"
          variant="secondary"
          fullWidth={false}
          onClick={() => navigate(`${sourceHref(source.id)}/merged/new`)}
        >
          Add merged table
        </Button>
      )}
      <Button
        size="sm"
        variant="secondary"
        fullWidth={false}
        onClick={() => setDialog("transfer")}
      >
        Transfer
      </Button>
      <Button size="sm" fullWidth={false} onClick={() => setDialog("edit")}>
        Edit
      </Button>
      <span className="z-source-actions-gap" />
      <ConfirmButton
        label="Delete"
        size="sm"
        danger
        confirmTitle="Delete source"
        confirmText={`Delete "${source.name}" and all its data? Zeteo holds the only copy, so it cannot be recovered. Saved queries and dashboards using it stop working.`}
        confirmLabel="Delete source"
        onConfirm={async () => {
          await remove.mutateAsync(source.id);
          navigate(access.isOwner ? MY_DATA_HREF : "/sources");
        }}
      />
    </div>
  );

  const dialogs = (
    <>
      {syncError?.code === "sync_too_soon" ? (
        <div className="z-source-result">
          <Alert variant="warning">Synced less than a minute ago</Alert>
        </div>
      ) : syncError?.code === "nothing_to_sync" ? (
        <div className="z-source-result">
          <Alert variant="warning">
            This source has no Google Sheets to sync
          </Alert>
        </div>
      ) : (
        <ErrorNotice error={syncError} />
      )}
      {synced && (
        <div className="z-source-result">
          <Alert
            variant={synced.tables.some((t) => t.error) ? "warning" : "success"}
          >
            {tablesSynced(synced)}
          </Alert>
        </div>
      )}
      {dialog === "edit" && (
        <SourceForm
          source={source}
          title="Edit source"
          dialog={{ onDone: close }}
          upload={{ canSetLimits: access.canSetLimits }}
        />
      )}
      {dialog === "transfer" && (
        <TransferDialog
          source={source}
          onClose={close}
          onDone={() => access.isOwner && navigate(MY_DATA_HREF)}
        />
      )}
    </>
  );

  return { actions, dialogs };
};
