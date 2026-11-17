import type { RunResult, StatSettings } from "../api/types";
import { formatNumber } from "./toOption";
import "./styles.css";

const number = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** The change from `previous` to `current` as a signed percentage, or null if it has no meaning. */
function change(current: number | null, previous: number | null) {
  if (current === null || previous === null || previous === 0) return null;
  const pct = ((current - previous) / Math.abs(previous)) * 100;
  const text = Math.abs(pct).toFixed(1);
  return { pct, text: `${pct < 0 ? "-" : "+"}${text}%` };
}

/** A single number: the first row's value, and with `compare`, the change from the second row. */
export function StatPanel({
  chart,
  result,
}: {
  chart: StatSettings;
  result: RunResult;
}) {
  const col = result.columns.findIndex((c) => c.name === chart.value);
  if (col < 0)
    return (
      <p className="z-chart-note">
        The result has no column &quot;{chart.value}&quot;.
      </p>
    );
  const current = number(result.rows[0]?.[col]);
  const delta =
    chart.compare === "next_row"
      ? change(current, number(result.rows[1]?.[col]))
      : null;
  return (
    <div className="z-stat">
      <div className="z-stat-value">
        <span>{formatNumber(current, chart.decimals)}</span>
        {chart.unit && current !== null && (
          <span className="z-stat-unit">{chart.unit}</span>
        )}
      </div>
      {delta && (
        <div
          className="z-stat-change"
          data-direction={
            delta.pct < 0 ? "down" : delta.pct > 0 ? "up" : "flat"
          }
        >
          {delta.text}
        </div>
      )}
    </div>
  );
}
