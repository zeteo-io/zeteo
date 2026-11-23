import { ShareDialog, TransferDialog } from "@/features/saved-queries";
import { IconAction } from "@/features/my/components/IconAction";
import { RowsLimitedPill } from "@/components/RowsLimitedPill";
import { PanelEditor, type EditorValue } from "./PanelEditor";
import { ConfirmButton } from "@/components/ConfirmButton";
import { ErrorNotice } from "@/components/ErrorNotice";
import { WarnDialog } from "@/components/WarnDialog";
import { NameDialog } from "./DashboardDialogs";
import type { SavedPanel } from "../api/types";
import { usePreview } from "../api/usePreview";
import { usedByWarning } from "@/utils/usedBy";
import { CHART_TYPES } from "./ChartFields";
import { PANEL_COPY } from "../panelCopy";
import { Chart } from "../charts/Chart";
import { useState } from "react";
import "./styles.css";
import {
  faCopy,
  faEye,
  faPen,
  faRightLeft,
  faShareNodes,
  faTrash,
} from "@fortawesome/free-solid-svg-icons";
import {
  useCopySavedPanel,
  useCreateSavedPanel,
  useDeleteSavedPanel,
  useSavedPanels,
  useUpdateSavedPanel,
} from "../api/useSavedPanels";
import {
  BorderedSection,
  Button,
  Card,
  Modal,
  Spinner,
} from "@kosmeo-ui/react";

type Dialog = "share" | "transfer" | "edit" | "edit-warning" | "copy" | null;

/** A saved panel's chart, run as the viewer, in a dialog of its own. */
const PreviewDialog = ({
  panel,
  onClose,
}: {
  panel: SavedPanel;
  onClose: () => void;
}) => {
  const preview = usePreview({ kind: "saved_panel", id: panel.id });
  return (
    <Modal show size="lg" title={panel.name} onClose={onClose}>
      {preview.isLoading ? (
        <Spinner size="md" />
      ) : preview.error ? (
        <ErrorNotice error={preview.error} />
      ) : preview.data && panel.chart ? (
        <div className="z-db-preview-dialog">
          {preview.data.rows_limited && <RowsLimitedPill />}
          <Chart chart={panel.chart} result={preview.data} />
        </div>
      ) : null}
    </Modal>
  );
};

const asInput = (value: EditorValue) =>
  value.kind === "own"
    ? {
        name: value.name ?? "",
        description: value.description,
        saved_query_id: value.saved_query_id,
        chart: value.chart,
        time_column: value.time_column,
      }
    : null;

const SavedPanelCard = ({
  panel,
  mine,
}: {
  panel: SavedPanel;
  mine: boolean;
}) => {
  const [dialog, setDialog] = useState<Dialog>(null);
  const [previewing, setPreviewing] = useState(false);
  const update = useUpdateSavedPanel();
  const remove = useDeleteSavedPanel();
  const copy = useCopySavedPanel();
  const close = () => setDialog(null);
  const used = (panel.used_by?.dashboards ?? 0) > 0;
  const ok = panel.state === "ok";
  const type = CHART_TYPES.find((t) => t.value === panel.chart?.type)?.label;

  return (
    <Card>
      <div className="z-db-card" data-saved-panel={panel.id}>
        <h3>{panel.name}</h3>
        {panel.description ? (
          <p>{panel.description}</p>
        ) : (
          <p className="z-note">No description.</p>
        )}
        {!ok && (
          <p className="z-note">
            {panel.message ??
              PANEL_COPY[panel.state as keyof typeof PANEL_COPY]}
          </p>
        )}
        <div className="z-db-foot">
          <p className="z-note">
            {!mine && <>From {panel.owner.name ?? "someone"} · </>}
            {type ?? "Chart"}
            {mine && panel.used_by && (
              <> · On {panel.used_by.dashboards} dashboards</>
            )}
          </p>
          <div className="z-db-actions">
            {ok && (
              <IconAction
                icon={faEye}
                label="Preview"
                onClick={() => setPreviewing(true)}
              />
            )}
            {mine ? (
              <>
                <IconAction
                  icon={faShareNodes}
                  label="Share"
                  onClick={() => setDialog("share")}
                />
                <IconAction
                  icon={faRightLeft}
                  label="Transfer"
                  onClick={() => setDialog("transfer")}
                />
                {ok && (
                  <IconAction
                    icon={faPen}
                    label="Edit"
                    onClick={() => setDialog(used ? "edit-warning" : "edit")}
                  />
                )}
                <ConfirmButton
                  label="Delete"
                  icon={faTrash}
                  size="sm"
                  danger
                  confirmTitle="Delete saved panel"
                  confirmText={
                    used && panel.used_by
                      ? `${usedByWarning(panel.used_by)} Delete "${panel.name}"? Its panels on those dashboards stop showing it.`
                      : `Delete "${panel.name}"? It stops being shared and cannot be recovered.`
                  }
                  confirmLabel="Delete"
                  onConfirm={() => remove.mutateAsync(panel.id)}
                />
              </>
            ) : (
              ok && (
                <IconAction
                  icon={faCopy}
                  label="Copy to mine"
                  onClick={() => setDialog("copy")}
                />
              )
            )}
          </div>
        </div>
      </div>
      {previewing && (
        <PreviewDialog panel={panel} onClose={() => setPreviewing(false)} />
      )}
      {dialog === "share" && (
        <ShareDialog objectType="saved_panel" id={panel.id} onClose={close} />
      )}
      {dialog === "transfer" && (
        <TransferDialog
          objectType="saved_panel"
          id={panel.id}
          onClose={close}
        />
      )}
      {dialog === "edit-warning" && panel.used_by && (
        <WarnDialog
          title="Edit saved panel"
          warning={usedByWarning(panel.used_by)}
          confirmLabel="Continue"
          onConfirm={() => setDialog("edit")}
          onClose={close}
        />
      )}
      {dialog === "edit" && (
        <PanelEditor
          heading="Edit saved panel"
          submitLabel="Save"
          purpose="saved_panel"
          initial={{
            kind: "own",
            saved_query_id: panel.saved_query_id,
            chart: panel.chart,
            time_column: panel.time_column,
            name: panel.name,
            description: panel.description,
          }}
          onSubmit={(value) => {
            const input = asInput(value)!;
            return update.mutateAsync({
              id: panel.id,
              changes: { ...input, time_column: input.time_column ?? null },
            });
          }}
          onClose={close}
        />
      )}
      {dialog === "copy" && (
        <NameDialog
          title="Copy to my saved panels"
          submitLabel="Copy"
          noun="saved panel"
          initialName={`${panel.name} (copy)`}
          onSubmit={({ name }) => copy.mutateAsync({ id: panel.id, name })}
          onClose={close}
        />
      )}
    </Card>
  );
};

const PanelList = ({ scope }: { scope: "mine" | "shared" }) => {
  const list = useSavedPanels(scope);
  return (
    <>
      {list.isLoading && <Spinner size="sm" />}
      <ErrorNotice error={list.error} />
      {!list.isLoading && !list.error && list.items.length === 0 && (
        <p className="z-note">
          {scope === "mine"
            ? "You have no saved panels yet. Save one from a dashboard's panel, or make a new one."
            : "No saved panels have been shared with you yet."}
        </p>
      )}
      {list.items.length > 0 && (
        <div className="z-db-grid">
          {list.items.map((p) => (
            <SavedPanelCard key={p.id} panel={p} mine={scope === "mine"} />
          ))}
        </div>
      )}
      {list.hasMore && (
        <div className="z-my-more">
          <Button
            size="sm"
            variant="secondary"
            fullWidth={false}
            onClick={list.loadMore}
          >
            Load more
          </Button>
        </div>
      )}
    </>
  );
};

/** The saved panels library: mine, and those shared with me. */
export const SavedPanelsPage = ({
  creating = false,
  onCreated,
}: {
  creating?: boolean;
  onCreated?: () => void;
}) => {
  const create = useCreateSavedPanel();
  return (
    <div className="z-db-sections">
      <BorderedSection title="My saved panels" as="h2">
        <PanelList scope="mine" />
      </BorderedSection>
      <BorderedSection title="Shared with me" as="h2">
        <PanelList scope="shared" />
      </BorderedSection>
      {creating && (
        <PanelEditor
          heading="New saved panel"
          submitLabel="Create saved panel"
          purpose="saved_panel"
          onSubmit={(value) => create.mutateAsync(asInput(value)!)}
          onClose={() => onCreated?.()}
        />
      )}
    </div>
  );
};
