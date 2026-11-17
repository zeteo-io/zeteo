import { DashboardDetailsDialog, NameDialog } from "./DashboardDialogs";
import { ShareDialog, TransferDialog } from "@/features/saved-queries";
import { IconAction } from "@/features/my/components/IconAction";
import { PanelEditor, type EditorValue } from "./PanelEditor";
import { DashboardGrid, type Place } from "./DashboardGrid";
import { ConfirmButton } from "@/components/ConfirmButton";
import { Badge, Button, Spinner } from "@kosmeo-ui/react";
import { useRunDashboard } from "../api/useRunDashboard";
import type { Panel, TimeRangeKey } from "../api/types";
import { useAutoRefresh } from "../api/useAutoRefresh";
import { ErrorNotice } from "@/components/ErrorNotice";
import { PageHeader } from "@/components/PageHeader";
import { Link, useNavigate } from "react-router-dom";
import { useEffect, useMemo, useRef, useState } from "react";
import { TimeRangePicker } from "./TimeRangePicker";
import { useDashboard } from "../api/useDashboard";
import { useUuidParam } from "@/lib/useUuidParam";
import { NotFound } from "@/components/NotFound";
import { RefreshPicker } from "./RefreshPicker";
import { usePanels } from "../api/usePanels";
import { useAuth } from "@tereo-io/react";
import { PanelFrame } from "./PanelFrame";
import { disagreement } from "./disagreement";
import { dashboardsHref } from "./tabs";
import type { Me } from "@/lib/auth";
import "./styles.css";
import {
  faArrowsRotate,
  faFloppyDisk,
  faLinkSlash,
  faPen,
  faTrash,
} from "@fortawesome/free-solid-svg-icons";
import {
  useCopyDashboard,
  useDeleteDashboard,
  useSaveDashboard,
} from "../api/useSaveDashboard";
import {
  intervalLabel,
  readRefreshChoice,
  writeRefreshChoice,
} from "../refreshOptions";

type Dialog =
  | { kind: "share" | "transfer" | "details" | "copy" | "add" }
  | { kind: "edit-panel" | "save-panel"; panel: Panel }
  | null;

/** A dashboard's page: `/dashboards/:dashboardId`. */
export const DashboardView = () => {
  const id = useUuidParam("dashboardId");
  return id ? <DashboardPage key={id} dashboardId={id} /> : <NotFound />;
};

const DashboardPage = ({ dashboardId }: { dashboardId: string }) => {
  const {
    data: dashboard,
    error,
    isLoading,
    refetch,
  } = useDashboard(dashboardId);
  const { user, hasPermission } = useAuth<Me>();
  const panelIds = useMemo(
    () => dashboard?.panels.map((p) => p.id) ?? [],
    [dashboard]
  );
  const runner = useRunDashboard(dashboardId, panelIds);
  const panelOps = usePanels(dashboardId);
  const save = useSaveDashboard(dashboardId);
  const remove = useDeleteDashboard();
  const copy = useCopyDashboard();
  const navigate = useNavigate();
  // The viewer's own range: undefined until they choose (the dashboard's default).
  const [chosen, setChosen] = useState<TimeRangeKey | null | undefined>();
  // The viewer's own auto-refresh, remembered in this browser: undefined until
  // they choose or one was remembered (then the dashboard's own interval).
  const [refreshChoice, setRefreshChoice] = useState<number | null | undefined>(
    () => readRefreshChoice(dashboardId)
  );
  const [editing, setEditing] = useState(false);
  const [places, setPlaces] = useState<Record<string, Place>>({});
  const [dialog, setDialog] = useState<Dialog>(null);
  const [now, setNow] = useState(() => Date.now());
  const loaded = dashboard !== undefined;
  const { run } = runner;

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  // Runs when the dashboard is first loaded and whenever the viewer picks a range.
  useEffect(() => {
    if (loaded) void run({ timeRange: chosen });
  }, [loaded, chosen, run]);

  const refreshSeconds =
    refreshChoice === undefined
      ? (dashboard?.refresh_seconds ?? null)
      : refreshChoice;
  useAutoRefresh({
    seconds: refreshSeconds,
    enabled: loaded,
    restartKey: chosen,
    running: runner.running,
    pauseWhenHidden: true,
    onTick: () => {
      void refetch();
      void run({ timeRange: chosen });
    },
  });

  // A line that disagrees with the dashboard (a panel fixed or added since it
  // loaded) reloads it, once for each new disagreement, as display mode does.
  const differs = disagreement(dashboard, runner.panels);
  const reloadedFor = useRef("");
  useEffect(() => {
    if (differs === reloadedFor.current) return;
    reloadedFor.current = differs;
    if (differs !== "") void refetch();
  }, [differs, refetch]);

  if (isLoading) return <Spinner size="lg" />;
  if (!dashboard) {
    return (
      <>
        <ErrorNotice error={error} />
        <p>
          <Link to={dashboardsHref("mine")}>My dashboards</Link>
        </p>
      </>
    );
  }

  const isOwner = !!user && dashboard.owner.id === user.id;
  const canManage = isOwner || hasPermission("zeteo.dashboards.write");
  const timeRange = chosen === undefined ? dashboard.time_range : chosen;
  const close = () => setDialog(null);
  const refreshPanel = (panelId: string) =>
    void run({ panels: [panelId], timeRange: chosen });

  const saveLayout = () =>
    save.mutate(
      {
        panels: dashboard.panels.map((p) => ({
          id: p.id,
          ...(places[p.id] ?? { x: p.x, y: p.y, w: p.w, h: p.h }),
        })),
      },
      {
        onSuccess: () => {
          setEditing(false);
          setPlaces({});
        },
      }
    );

  const addPanel = async (value: EditorValue) => {
    const added = await panelOps.add.mutateAsync(
      value.kind === "own"
        ? {
            kind: "own",
            saved_query_id: value.saved_query_id,
            chart: value.chart,
            time_column: value.time_column,
            title: value.title,
          }
        : value
    );
    void run({ panels: [added.id], timeRange: chosen });
  };

  const editPanel = async (panel: Panel, value: EditorValue) => {
    await panelOps.update.mutateAsync({
      panelId: panel.id,
      changes:
        value.kind === "own"
          ? {
              title: value.title ?? null,
              saved_query_id: value.saved_query_id,
              chart: value.chart,
              time_column: value.time_column ?? null,
            }
          : { title: value.title ?? null },
    });
    refreshPanel(panel.id);
  };

  const panelActions = (panel: Panel) =>
    editing && isOwner ? (
      <>
        {(panel.state === "ok" || panel.kind === "own") && (
          <IconAction
            icon={faPen}
            label="Edit panel"
            onClick={() => setDialog({ kind: "edit-panel", panel })}
          />
        )}
        {panel.kind === "linked" && panel.state === "ok" && (
          <ConfirmButton
            label="Detach"
            icon={faLinkSlash}
            size="sm"
            confirmTitle="Detach panel"
            confirmText="The panel gets its own copy of the saved panel's saved query, chart and time column, and no longer changes with the saved panel."
            confirmLabel="Detach"
            onConfirm={async () => {
              await panelOps.detach.mutateAsync(panel.id);
              refreshPanel(panel.id);
            }}
          />
        )}
        {panel.kind === "own" && panel.state === "ok" && (
          <IconAction
            icon={faFloppyDisk}
            label="Save as saved panel"
            onClick={() => setDialog({ kind: "save-panel", panel })}
          />
        )}
        <ConfirmButton
          label="Remove panel"
          icon={faTrash}
          size="sm"
          danger
          confirmTitle="Remove panel"
          confirmText={`Remove "${panel.title ?? "Untitled panel"}" from this dashboard?`}
          confirmLabel="Remove"
          onConfirm={() => panelOps.remove.mutateAsync(panel.id)}
        />
      </>
    ) : undefined;

  const actions = (
    <div className="z-header-actions">
      {editing ? (
        <>
          <Button
            size="sm"
            fullWidth={false}
            onClick={() => setDialog({ kind: "add" })}
          >
            Add panel
          </Button>
          <Button
            size="sm"
            fullWidth={false}
            isLoading={save.isPending}
            onClick={saveLayout}
          >
            Save layout
          </Button>
          <Button
            size="sm"
            variant="secondary"
            fullWidth={false}
            onClick={() => {
              setEditing(false);
              setPlaces({});
            }}
          >
            Cancel
          </Button>
        </>
      ) : (
        <>
          <Button
            size="sm"
            variant="secondary"
            fullWidth={false}
            onClick={() => navigate(`/dashboards/${dashboard.id}/display`)}
          >
            Display
          </Button>
          {isOwner && (
            <>
              <Button
                size="sm"
                variant="secondary"
                fullWidth={false}
                onClick={() => setEditing(true)}
              >
                Edit layout
              </Button>
              <Button
                size="sm"
                variant="secondary"
                fullWidth={false}
                onClick={() => setDialog({ kind: "details" })}
              >
                Edit details
              </Button>
            </>
          )}
          {!isOwner && (
            <Button
              size="sm"
              variant="secondary"
              fullWidth={false}
              onClick={() => setDialog({ kind: "copy" })}
            >
              Copy to mine
            </Button>
          )}
          {canManage && (
            <>
              <Button
                size="sm"
                variant="secondary"
                fullWidth={false}
                onClick={() => setDialog({ kind: "share" })}
              >
                Share
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
                confirmTitle="Delete dashboard"
                confirmText={`Delete "${dashboard.name}"? Its panels go with it, it stops being shared, and it cannot be recovered.`}
                confirmLabel="Delete"
                onConfirm={async () => {
                  await remove.mutateAsync(dashboard.id);
                  navigate(dashboardsHref("mine"));
                }}
              />
            </>
          )}
        </>
      )}
    </div>
  );

  const backTab = isOwner || !dashboard.shared_at ? "mine" : "shared";

  return (
    <>
      <Link className="z-muted-link z-back-link" to={dashboardsHref(backTab)}>
        ← {backTab === "mine" ? "My dashboards" : "Shared with me"}
      </Link>
      <div className="z-source-header">
        <PageHeader
          title={dashboard.name}
          badges={
            <Badge size="sm" variant="secondary">
              {isOwner ? "Yours" : `From ${dashboard.owner.name ?? "someone"}`}
            </Badge>
          }
          actions={actions}
          divider={false}
        />
      </div>
      {dashboard.description && (
        <p className="z-table-description">{dashboard.description}</p>
      )}
      <div className="z-dashboard-toolbar">
        <div className="z-dashboard-range">
          <TimeRangePicker value={timeRange} onChange={setChosen} />
        </div>
        <div className="z-dashboard-refresh">
          <RefreshPicker
            value={refreshSeconds}
            onChange={(v) => {
              setRefreshChoice(v);
              writeRefreshChoice(dashboardId, v);
            }}
          />
        </div>
        {refreshSeconds !== null ? (
          <span className="z-dashboard-live">
            <Badge size="sm" variant="success">
              Live · every {intervalLabel(refreshSeconds)}
            </Badge>
          </span>
        ) : (
          // Manual refresh only while auto-refresh is off.
          <span className="z-dashboard-refresh-all">
            <IconAction
              icon={faArrowsRotate}
              label="Refresh all"
              onClick={() => void run({ timeRange: chosen })}
            />
          </span>
        )}
      </div>
      <ErrorNotice error={save.error} />
      {runner.error && runner.error.code !== "cancelled" && (
        <ErrorNotice error={runner.error} />
      )}
      {dashboard.panels.length === 0 ? (
        <p className="z-note">
          {isOwner
            ? "No panels yet. Choose Edit layout, then Add panel."
            : "This dashboard has no panels yet."}
        </p>
      ) : (
        <DashboardGrid
          panels={dashboard.panels}
          places={places}
          editing={editing}
          onPlacesChange={setPlaces}
          renderPanel={(panel) => (
            <PanelFrame
              panel={panel}
              run={runner.panels[panel.id]}
              now={now}
              onRefresh={
                refreshSeconds === null
                  ? () => refreshPanel(panel.id)
                  : undefined
              }
              actions={panelActions(panel)}
            />
          )}
        />
      )}

      {dialog?.kind === "share" && (
        <ShareDialog objectType="dashboard" id={dashboard.id} onClose={close} />
      )}
      {dialog?.kind === "transfer" && (
        <TransferDialog
          objectType="dashboard"
          id={dashboard.id}
          onClose={close}
        />
      )}
      {dialog?.kind === "details" && (
        <DashboardDetailsDialog dashboard={dashboard} onClose={close} />
      )}
      {dialog?.kind === "copy" && (
        <NameDialog
          title="Copy to my dashboards"
          submitLabel="Copy"
          noun="dashboard"
          initialName={`${dashboard.name} (copy)`}
          onSubmit={async ({ name }) => {
            const made = await copy.mutateAsync({ id: dashboard.id, name });
            navigate(`/dashboards/${made.id}`);
          }}
          onClose={close}
        />
      )}
      {dialog?.kind === "add" && (
        <PanelEditor
          heading="Add panel"
          submitLabel="Add panel"
          purpose="dashboard"
          allowLinked
          onSubmit={addPanel}
          onClose={close}
        />
      )}
      {dialog?.kind === "edit-panel" && (
        <PanelEditor
          heading="Edit panel"
          submitLabel="Save panel"
          purpose="dashboard"
          initial={{
            kind: dialog.panel.kind,
            saved_query_id: dialog.panel.saved_query_id,
            saved_panel_id: dialog.panel.saved_panel_id,
            chart: dialog.panel.chart,
            time_column: dialog.panel.time_column,
            title: dialog.panel.title ?? undefined,
          }}
          onSubmit={(value) => editPanel(dialog.panel, value)}
          onClose={close}
        />
      )}
      {dialog?.kind === "save-panel" && (
        <NameDialog
          title="Save as saved panel"
          submitLabel="Save saved panel"
          noun="saved panel"
          initialName={dialog.panel.title ?? ""}
          withDescription
          onSubmit={({ name, description }) =>
            panelOps.saveAs.mutateAsync({
              panelId: dialog.panel.id,
              name,
              ...(description && { description }),
            })
          }
          onClose={close}
        />
      )}
    </>
  );
};
