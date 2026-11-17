import type { ChartSettings, RunResult } from "../api/types";
import { useEffect, useMemo, useRef } from "react";
import { TablePanel } from "./TablePanel";
import { StatPanel } from "./StatPanel";
import { toOption } from "./toOption";
import { chartTheme } from "./theme";
import { init } from "./echarts";
import "./styles.css";

type EChart = ReturnType<typeof init>;

function Canvas({
  chart,
  result,
}: {
  chart: Exclude<ChartSettings, { type: "stat" | "table" }>;
  result: RunResult;
}) {
  const box = useRef<HTMLDivElement>(null);
  const instance = useRef<EChart | null>(null);
  const built = useMemo(() => {
    try {
      return { option: toOption(chart, result, chartTheme()), error: null };
    } catch (err) {
      return {
        option: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }, [chart, result]);

  // One instance for the element's life; resized with its box.
  useEffect(() => {
    const el = box.current;
    if (!el || built.error !== null) return;
    const chartInstance = init(el);
    instance.current = chartInstance;
    const observer = new ResizeObserver(() => chartInstance.resize());
    observer.observe(el);
    return () => {
      observer.disconnect();
      chartInstance.dispose();
      instance.current = null;
    };
  }, [built.error !== null]);

  useEffect(() => {
    if (built.option)
      instance.current?.setOption(built.option, { notMerge: true });
  }, [built]);

  if (built.error !== null)
    return <p className="z-chart-note">{built.error}</p>;
  return <div ref={box} className="z-chart" />;
}

/** A panel's visualisation: ECharts for line, area, bar and pie; kosmeo components for stat and table. */
export function Chart({
  chart,
  result,
}: {
  chart: ChartSettings;
  result: RunResult;
}) {
  if (chart.type === "stat") return <StatPanel chart={chart} result={result} />;
  if (chart.type === "table")
    return <TablePanel chart={chart} result={result} />;
  return <Canvas chart={chart} result={result} />;
}
