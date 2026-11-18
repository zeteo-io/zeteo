import { formatNumber } from "@/features/dashboards/charts/toOption";
import { problemText } from "@/features/dashboards/editing";
import { Chart } from "@/features/dashboards/charts/Chart";
import { CardToolError, type CardHost } from "./host";
import { useEffect, useState } from "react";
import { Spinner } from "@kosmeo-ui/react";
import type {
  ChartProblem,
  ChartSettings,
  ResultColumn,
} from "@/features/dashboards/api/types";

/** What `card_panel_rows` returns. */
interface PanelRows {
  title: string | null;
  chart: ChartSettings;
  columns: ResultColumn[];
  rows: unknown[][];
  truncated: boolean;
  problems: ChartProblem[];
}

const PREVIEW_KEYS = [
  "saved_query_id",
  "chart",
  "time_column",
  "time_range",
] as const;

/**
 * What to ask `card_panel_rows` for: a saved panel named by the input's id
 * (get or update a saved panel), else the saved panel a create made (an input
 * with a `name` and a result with an `id`), else the saved query and chart in
 * the input (preview), else a saved panel named by the result's id.
 */
export const panelRowsArgs = (
  input: Record<string, unknown>,
  result: Record<string, unknown>
): Record<string, unknown> | null => {
  if (typeof input.id === "string") return { saved_panel_id: input.id };
  // create_saved_panel: the saved panel it made, under its name.
  if (typeof input.name === "string" && typeof result.id === "string")
    return { saved_panel_id: result.id };
  if (typeof input.saved_query_id === "string" && input.chart) {
    const args: Record<string, unknown> = {};
    for (const key of PREVIEW_KEYS)
      if (input[key] !== undefined) args[key] = input[key];
    return args;
  }
  if (typeof result.id === "string") return { saved_panel_id: result.id };
  return null;
};

const errorText = (err: unknown) =>
  err instanceof CardToolError
    ? err.message
    : "The preview could not be loaded.";

type Load =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: PanelRows };

/** A panel's preview: its title, chart, problems, and a note when the rows were cut. */
export const PanelCard = ({
  host,
  input,
  result,
}: {
  host: CardHost;
  input: Record<string, unknown>;
  result: Record<string, unknown>;
}) => {
  const args = panelRowsArgs(input, result);
  const key = JSON.stringify(args);
  const [load, setLoad] = useState<Load>({ status: "loading" });

  useEffect(() => {
    const asked = JSON.parse(key) as Record<string, unknown> | null;
    if (!asked) return;
    let live = true;
    setLoad({ status: "loading" });
    host.callTool("card_panel_rows", asked).then(
      (data) => live && setLoad({ status: "ready", data: data as PanelRows }),
      (err) => live && setLoad({ status: "error", message: errorText(err) })
    );
    return () => {
      live = false;
    };
  }, [host, key]);

  if (!args) return <p className="zc-message">Nothing to preview.</p>;
  if (load.status === "loading")
    return (
      <div className="zc-loading">
        <Spinner size="sm" />
      </div>
    );
  if (load.status === "error")
    return <p className="zc-message">{load.message}</p>;

  const { data } = load;
  return (
    <section className="zc-panel-card" aria-label={data.title ?? "Preview"}>
      <h2 className="zc-title">{data.title ?? "Preview"}</h2>
      {data.problems.length > 0 && (
        <ul className="zc-problems">
          {data.problems.map((p, i) => (
            <li key={i}>
              <code>{p.setting}</code>: {problemText(p.problem)}
            </li>
          ))}
        </ul>
      )}
      <div className="zc-panel-chart">
        <Chart
          chart={data.chart}
          result={{
            columns: data.columns,
            rows: data.rows,
            truncated: data.truncated,
          }}
        />
      </div>
      {data.truncated && (
        <p className="zc-note">
          Showing the first {formatNumber(data.rows.length)} rows
        </p>
      )}
    </section>
  );
};
