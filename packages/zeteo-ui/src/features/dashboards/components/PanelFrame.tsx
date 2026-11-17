import { faRotateRight } from "@fortawesome/free-solid-svg-icons";
import { IconAction } from "@/features/my/components/IconAction";
import { formatRelative } from "@/utils/formatRelative";
import type { PanelRun } from "../api/useRunDashboard";
import type { Panel, PanelState } from "../api/types";
import { formatDate } from "@/utils/formatDate";
import { Spinner } from "@kosmeo-ui/react";
import { problemText } from "../editing";
import { Chart } from "../charts/Chart";
import type { ReactNode } from "react";

/** What each state that is not `ok` tells the viewer. */
export const PANEL_COPY: Record<Exclude<PanelState, "ok">, string> = {
  not_accessible:
    "You need expanded permissions to run this saved query. Ask an admin to extend your access.",
  saved_query_deleted: "This panel's saved query was deleted.",
  saved_panel_deleted: "This panel's saved panel was deleted.",
  not_available: "This saved query is no longer available for dashboards.",
  needs_update: "This panel needs updating by its owner.",
};

/** What a viewer is told of a result cut at the row cap. */
export const truncatedNotice = (rows: number) =>
  `Showing the first ${rows.toLocaleString("en-US")} rows; aggregate the saved query to see everything.`;

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

interface PanelFrameProps {
  panel: Panel;
  run?: PanelRun;
  /** Re-renders "updated n min ago" as time passes. */
  now: number;
  onRefresh?: () => void;
  /** The editor's own actions, shown in edit mode. */
  actions?: ReactNode;
}

/** One panel: its title, how fresh it is, a refresh button, and its chart or its state's message. */
export const PanelFrame = ({
  panel,
  run,
  now,
  onRefresh,
  actions,
}: PanelFrameProps) => {
  const state = run?.state ?? panel.state;
  const message =
    state === "ok"
      ? undefined
      : (run?.message ?? panel.message ?? PANEL_COPY[state]);
  const result = state === "ok" ? run?.result : undefined;
  const notice =
    result?.truncated_by === "rows"
      ? (result.notice ?? truncatedNotice(result.rows.length))
      : undefined;

  return (
    <section
      className="z-panel"
      data-panel={panel.id}
      aria-label={panel.title ?? "Untitled panel"}
    >
      <header className="z-panel-head">
        <h3 className="z-panel-title">{panel.title ?? "Untitled panel"}</h3>
        <div className="z-panel-meta">
          {run?.staleSince ? (
            <span
              className="z-panel-stale"
              title={run.error?.error_description}
            >
              Stale since {clock(run.staleSince)}
            </span>
          ) : (
            run?.updatedAt && (
              <time
                className="z-muted"
                dateTime={run.updatedAt}
                title={formatDate(run.updatedAt)}
              >
                Updated {formatRelative(run.updatedAt, now)}
              </time>
            )
          )}
          {run?.loading && <Spinner size="sm" />}
          {onRefresh && state === "ok" && (
            <IconAction
              icon={faRotateRight}
              label="Refresh"
              onClick={onRefresh}
            />
          )}
          {actions}
        </div>
      </header>
      <div className="z-panel-body">
        {message !== undefined ? (
          <div className="z-panel-message">
            <p>{message}</p>
            {panel.problems && panel.problems.length > 0 && (
              <ul>
                {panel.problems.map((p, i) => (
                  <li key={i}>
                    <code>{p.setting}</code>: {problemText(p.problem)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : result && panel.chart ? (
          <>
            <div className="z-panel-chart">
              <Chart chart={panel.chart} result={result} />
            </div>
            {notice && <p className="z-panel-notice">{notice}</p>}
          </>
        ) : run?.error ? (
          <p className="z-panel-message">{run.error.error_description}</p>
        ) : (
          <Spinner size="sm" />
        )}
      </div>
    </section>
  );
};
