import type { RunResult, TableSettings } from "../api/types";
import { formatNumber } from "./toOption";
import { Table } from "@kosmeo-ui/react";
import "./styles.css";

function cell(value: unknown, type: string, decimals?: number): string {
  if (value === null || value === undefined) return "";
  if (type === "number") return formatNumber(value, decimals);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** The result as a table: all columns, or the chosen ones in the chosen order. */
export function TablePanel({
  chart,
  result,
}: {
  chart: TableSettings;
  result: RunResult;
}) {
  const names = chart.columns ?? result.columns.map((c) => c.name);
  const missing = names.find((n) => !result.columns.some((c) => c.name === n));
  if (missing !== undefined)
    return (
      <p className="z-chart-note">
        The result has no column &quot;{missing}&quot;.
      </p>
    );
  const columns = names.map((name) => {
    const index = result.columns.findIndex((c) => c.name === name);
    const type = result.columns[index].type;
    return {
      title: name,
      cellElement: (row: unknown[]) => cell(row[index], type, chart.decimals),
    };
  });
  return (
    <div className="z-table-panel">
      <Table<unknown[]>
        columns={columns}
        rows={result.rows}
        rowKey={(_, i) => i}
        maxHeight="100%"
        striped
      />
    </div>
  );
}
