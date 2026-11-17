import type { ChartSettings, ChartType, ResultColumn } from "../api/types";
import { Checkbox, Input, SearchSelect, Switch } from "@kosmeo-ui/react";
import { fieldOf, problemText } from "../editing";
import type { ReactNode } from "react";

export const CHART_TYPES: { value: ChartType; label: string }[] = [
  { value: "stat", label: "Stat" },
  { value: "line", label: "Line" },
  { value: "area", label: "Area" },
  { value: "bar", label: "Bar" },
  { value: "pie", label: "Pie" },
  { value: "table", label: "Table" },
];

interface Option {
  value: string | null;
  label: string;
}

const NONE: Option = { value: null, label: "None" };

/** A setting's field, with the server's problem with it (if any) beside it. */
export const Setting = ({
  name,
  problems,
  children,
}: {
  name: string;
  problems: Record<string, string[]>;
  children: ReactNode;
}) => (
  <div className="z-pe-field" data-setting={name}>
    {children}
    {problems[name]?.map((p, i) => (
      <p key={i} className="z-pe-problem" role="alert">
        {problemText(p)}
      </p>
    ))}
  </div>
);

/** A column picker over `columns` (with "None" when optional). */
const ColumnSelect = ({
  label,
  value,
  columns,
  optional,
  onChange,
}: {
  label: string;
  value: string | undefined;
  columns: ResultColumn[];
  optional?: boolean;
  onChange: (name: string | undefined) => void;
}) => {
  const options: Option[] = [
    ...(optional ? [NONE] : []),
    ...columns.map((c) => ({ value: c.name, label: c.name })),
  ];
  const chosen =
    options.find((o) => o.value === (value ?? null)) ??
    (value ? { value, label: value } : optional ? NONE : null);
  return (
    <SearchSelect<Option>
      label={label}
      value={chosen}
      options={options}
      getOptionLabel={(o) => o.label}
      getOptionKey={(o) => o.value ?? ""}
      onSelect={(o) => onChange(o.value ?? undefined)}
    />
  );
};

/** Problems by field: `y.1` and `y.0` both under `y`. */
export const problemsByField = (
  problems: { setting: string; problem: string }[] | undefined
): Record<string, string[]> => {
  const out: Record<string, string[]> = {};
  for (const p of problems ?? []) {
    (out[fieldOf(p.setting)] ??= []).push(p.problem);
  }
  return out;
};

interface ChartFieldsProps {
  chart: ChartSettings;
  columns: ResultColumn[];
  problems: Record<string, string[]>;
  onChange: (chart: ChartSettings) => void;
}

/** The settings of one chart type, over the result's columns. */
export const ChartFields = ({
  chart,
  columns,
  problems,
  onChange,
}: ChartFieldsProps) => {
  const numbers = columns.filter((c) => c.type === "number");
  const texts = columns.filter((c) => c.type === "text");
  const set = (changes: Record<string, unknown>) =>
    onChange({ ...chart, ...changes } as ChartSettings);
  const at = (name: string, node: ReactNode) => (
    <Setting name={name} problems={problems}>
      {node}
    </Setting>
  );
  const decimals = at(
    "decimals",
    <Input
      label="Decimals"
      type="number"
      min={0}
      max={6}
      value={chart.decimals === undefined ? "" : String(chart.decimals)}
      onChange={(e) => {
        const n = e.target.value === "" ? undefined : Number(e.target.value);
        set({
          decimals:
            n === undefined || !Number.isInteger(n)
              ? undefined
              : Math.min(6, Math.max(0, n)),
        });
      }}
    />
  );
  const legend = at(
    "legend",
    <Switch
      label="Show legend"
      size="sm"
      checked={chart.legend !== "none"}
      onChange={(e) => set({ legend: e.target.checked ? undefined : "none" })}
    />
  );

  switch (chart.type) {
    case "stat":
      return (
        <div className="z-pe-settings">
          {at(
            "value",
            <ColumnSelect
              label="Value"
              value={chart.value}
              columns={numbers}
              onChange={(value) => set({ value: value ?? "" })}
            />
          )}
          {at(
            "unit",
            <Input
              label="Unit"
              value={chart.unit ?? ""}
              max={20}
              onChange={(e) => set({ unit: e.target.value || undefined })}
            />
          )}
          {decimals}
          {at(
            "compare",
            <Switch
              label="Show the change from the next row"
              size="sm"
              checked={chart.compare === "next_row"}
              onChange={(e) =>
                set({ compare: e.target.checked ? "next_row" : undefined })
              }
            />
          )}
        </div>
      );
    case "line":
    case "area":
    case "bar":
      return (
        <div className="z-pe-settings">
          {at(
            "x",
            <ColumnSelect
              label="X axis"
              value={chart.x}
              columns={
                chart.type === "bar"
                  ? columns
                  : columns.filter((c) =>
                      ["date", "timestamp", "number"].includes(c.type)
                    )
              }
              onChange={(x) => set({ x: x ?? "" })}
            />
          )}
          {at(
            "series",
            <ColumnSelect
              label="Series"
              value={chart.series}
              columns={texts}
              optional
              onChange={(series) => set({ series })}
            />
          )}
          {at(
            "y",
            <fieldset className="z-pe-checks">
              <legend>Values</legend>
              {numbers
                .filter((c) => c.name !== chart.x)
                .map((c) => (
                  <Checkbox
                    key={c.name}
                    label={c.name}
                    labelLocation="right"
                    checked={chart.y.includes(c.name)}
                    onChange={(e) =>
                      set({
                        y: e.target.checked
                          ? [...chart.y, c.name].slice(0, 10)
                          : chart.y.filter((y) => y !== c.name),
                      })
                    }
                  />
                ))}
            </fieldset>
          )}
          {decimals}
          {chart.type !== "line" &&
            at(
              "stacked",
              <Switch
                label="Stacked"
                size="sm"
                checked={chart.stacked === true}
                onChange={(e) =>
                  set({ stacked: e.target.checked || undefined })
                }
              />
            )}
          {chart.type === "bar" &&
            at(
              "horizontal",
              <Switch
                label="Horizontal"
                size="sm"
                checked={chart.horizontal === true}
                onChange={(e) =>
                  set({ horizontal: e.target.checked || undefined })
                }
              />
            )}
          {legend}
        </div>
      );
    case "pie":
      return (
        <div className="z-pe-settings">
          {at(
            "label",
            <ColumnSelect
              label="Label"
              value={chart.label}
              columns={texts}
              onChange={(label) => set({ label: label ?? "" })}
            />
          )}
          {at(
            "value",
            <ColumnSelect
              label="Value"
              value={chart.value}
              columns={numbers}
              onChange={(value) => set({ value: value ?? "" })}
            />
          )}
          {decimals}
          {at(
            "donut",
            <Switch
              label="Donut"
              size="sm"
              checked={chart.donut === true}
              onChange={(e) => set({ donut: e.target.checked || undefined })}
            />
          )}
          {legend}
        </div>
      );
    case "table":
      return <div className="z-pe-settings">{decimals}</div>;
  }
};
