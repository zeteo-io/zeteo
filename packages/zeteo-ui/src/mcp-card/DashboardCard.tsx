import { TIME_RANGE_LABELS } from "@/features/dashboards/timeRanges";
import { useEffect, useState, type CSSProperties } from "react";
import { PANEL_COPY } from "@/features/dashboards/panelCopy";
import { Chart } from "@/features/dashboards/charts/Chart";
import { CardToolError, type CardHost } from "./host";
import { Button, Spinner } from "@kosmeo-ui/react";
import type {
  ChartSettings,
  PanelResult,
  PanelState,
  TimeRangeKey,
} from "@/features/dashboards/api/types";
import {
  GRID_COLUMNS,
  GRID_GAP,
  GRID_ROW_HEIGHT,
} from "@/features/dashboards/grid";

/** At most this many panels' rows are asked for in one call (the tool allows 1-4). */
export const ROWS_BATCH = 4;
/** Narrower than this, panels stack one per row. */
export const STACK_BELOW = 480;

export const TOO_LARGE = "Too large to preview; open in Zeteo.";

/** A panel's place and settings, from `card_dashboard` without `panel_ids`. */
interface LayoutPanel {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string | null;
  state: PanelState;
  chart?: ChartSettings;
  message?: string;
}

interface Layout {
  id: string;
  name: string;
  url: string | null;
  time_range: string | null;
  panels: LayoutPanel[];
}

/** One panel's run: a `PanelLine`, or `{ id, state: "too_large" }`. */
interface RunLine {
  panel_id?: string;
  id?: string;
  state: PanelState | "too_large";
  message?: string;
  result?: PanelResult;
  error?: { error_description: string };
}

type Run = RunLine | { failed: string };

/** The dashboard: the input's `dashboard_id`, else its `id`, else the result's. */
export const dashboardIdOf = (
  input: Record<string, unknown>,
  result: Record<string, unknown>
): string | null => {
  for (const v of [
    input.dashboard_id,
    input.id,
    result.dashboard_id,
    result.id,
  ])
    if (typeof v === "string") return v;
  return null;
};

const errorText = (err: unknown) =>
  err instanceof CardToolError ? err.message : "This could not be loaded.";

/** Reading order: top to bottom, then left to right. */
const byPlace = (a: LayoutPanel, b: LayoutPanel) => a.y - b.y || a.x - b.x;

/** The window's width (the card's, inside the host's frame), kept current. */
const useWidth = () => {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const update = () => setWidth(window.innerWidth);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return width;
};

/** What a panel the card cannot draw says: one of a state it does not know has a fallback. */
export const CANNOT_PREVIEW = "This panel can't be previewed.";

const stateMessage = (state: string, message?: string) =>
  state === "ok"
    ? undefined
    : (message ??
      PANEL_COPY[state as keyof typeof PANEL_COPY] ??
      CANNOT_PREVIEW);

/** Only a web address is offered as a link out of the card. */
const isWebUrl = (url: string | null): url is string => {
  if (!url) return false;
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
};

const PanelBody = ({ panel, run }: { panel: LayoutPanel; run?: Run }) => {
  const fromLayout = stateMessage(panel.state, panel.message);
  if (fromLayout !== undefined)
    return <p className="zc-message">{fromLayout}</p>;
  if (!run)
    return (
      <div className="zc-loading">
        <Spinner size="sm" />
      </div>
    );
  if ("failed" in run) return <p className="zc-message">{run.failed}</p>;
  if (run.state === "too_large")
    return <p className="zc-message">{TOO_LARGE}</p>;
  if (run.error)
    return <p className="zc-message">{run.error.error_description}</p>;
  const fromRun = stateMessage(run.state, run.message);
  if (fromRun !== undefined) return <p className="zc-message">{fromRun}</p>;
  if (!run.result || !panel.chart)
    return <p className="zc-message">This panel could not be loaded.</p>;
  return (
    <>
      <div className="zc-panel-chart">
        <Chart chart={panel.chart} result={run.result} />
      </div>
      {run.result.notice && <p className="zc-note">{run.result.notice}</p>}
    </>
  );
};

type Load =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; layout: Layout };

/**
 * A dashboard's preview: its name, its panels on the 12-column grid (stacked
 * below 480 px), each panel's chart or its state's message, and "Open in
 * Zeteo". The layout comes first; rows follow a few panels at a time, so no
 * one result nears the host's size cap.
 */
export const DashboardCard = ({
  host,
  input,
  result,
}: {
  host: CardHost;
  input: Record<string, unknown>;
  result: Record<string, unknown>;
}) => {
  const dashboardId = dashboardIdOf(input, result);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [runs, setRuns] = useState<Record<string, Run>>({});
  const width = useWidth();

  useEffect(() => {
    if (!dashboardId) return;
    let live = true;
    setLoad({ status: "loading" });
    setRuns({});
    const read = async () => {
      let layout: Layout;
      try {
        layout = (await host.callTool("card_dashboard", {
          dashboard_id: dashboardId,
        })) as Layout;
      } catch (err) {
        if (live) setLoad({ status: "error", message: errorText(err) });
        return;
      }
      if (!live) return;
      setLoad({ status: "ready", layout });
      const ids = [...layout.panels]
        .filter((p) => p.state === "ok")
        .sort(byPlace)
        .map((p) => p.id);
      for (let i = 0; i < ids.length && live; i += ROWS_BATCH) {
        const batch = ids.slice(i, i + ROWS_BATCH);
        let got: Record<string, Run>;
        try {
          const answer = (await host.callTool("card_dashboard", {
            dashboard_id: dashboardId,
            panel_ids: batch,
          })) as { panels?: RunLine[] };
          got = Object.fromEntries(
            (answer.panels ?? []).map((line) => [
              line.panel_id ?? line.id ?? "",
              line,
            ])
          );
          for (const id of batch)
            got[id] ??= { failed: "This panel could not be loaded." };
        } catch (err) {
          const failed = errorText(err);
          got = Object.fromEntries(batch.map((id) => [id, { failed }]));
        }
        if (live) setRuns((prev) => ({ ...prev, ...got }));
      }
    };
    void read();
    return () => {
      live = false;
    };
  }, [host, dashboardId]);

  if (!dashboardId) return <p className="zc-message">Nothing to preview.</p>;
  if (load.status === "loading")
    return (
      <div className="zc-loading">
        <Spinner size="sm" />
      </div>
    );
  if (load.status === "error")
    return <p className="zc-message">{load.message}</p>;

  const { layout } = load;
  const stacked = width < STACK_BELOW;
  const range =
    layout.time_range &&
    (TIME_RANGE_LABELS[layout.time_range as TimeRangeKey] ?? null);
  const panels = [...layout.panels].sort(byPlace);
  const place = (p: LayoutPanel): CSSProperties =>
    stacked
      ? { height: p.h * GRID_ROW_HEIGHT + (p.h - 1) * GRID_GAP }
      : {
          gridColumn: `${p.x + 1} / span ${p.w}`,
          gridRow: `${p.y + 1} / span ${p.h}`,
        };

  return (
    <section className="zc-dashboard" aria-label={layout.name}>
      <header className="zc-head">
        <div className="zc-head-text">
          <h2 className="zc-title">{layout.name}</h2>
          {range && <span className="zc-muted">{range}</span>}
        </div>
        {isWebUrl(layout.url) && (
          <Button
            size="sm"
            variant="secondary"
            fullWidth={false}
            onClick={() => host.openLink(layout.url as string)}
          >
            Open in Zeteo
          </Button>
        )}
      </header>
      {panels.length === 0 ? (
        <p className="zc-message">No panels yet</p>
      ) : (
        <div
          className="zc-grid"
          data-layout={stacked ? "stack" : "grid"}
          style={
            stacked
              ? { gap: GRID_GAP }
              : {
                  gap: GRID_GAP,
                  gridTemplateColumns: `repeat(${GRID_COLUMNS}, minmax(0, 1fr))`,
                  gridAutoRows: GRID_ROW_HEIGHT,
                }
          }
        >
          {panels.map((p) => (
            <section
              key={p.id}
              className="zc-panel"
              data-panel={p.id}
              aria-label={p.title ?? "Untitled panel"}
              style={place(p)}
            >
              <h3 className="zc-panel-title">{p.title ?? "Untitled panel"}</h3>
              <div className="zc-panel-body">
                <PanelBody panel={p} run={runs[p.id]} />
              </div>
            </section>
          ))}
        </div>
      )}
    </section>
  );
};
