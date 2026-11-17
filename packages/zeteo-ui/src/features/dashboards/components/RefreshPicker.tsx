import { REFRESH_CHOICES, intervalLabel } from "../refreshOptions";
import { SearchSelect } from "@kosmeo-ui/react";

interface Option {
  value: number | null;
  label: string;
}

/** Auto-refresh: Off or a few minute intervals, plus `value` itself when it is none of them. */
export const RefreshPicker = ({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (value: number | null) => void;
}) => {
  const options: Option[] = REFRESH_CHOICES.map((v) => ({
    value: v,
    label: v === null ? "Off" : intervalLabel(v),
  }));
  if (value !== null && !REFRESH_CHOICES.includes(value)) {
    options.push({ value, label: `Every ${intervalLabel(value)}` });
    options.sort((a, b) => (a.value ?? 0) - (b.value ?? 0));
  }
  return (
    <SearchSelect<Option>
      label="Auto-refresh"
      size="sm"
      value={options.find((o) => o.value === value) ?? options[0]}
      options={options}
      getOptionLabel={(o) => o.label}
      getOptionKey={(o) => String(o.value ?? "off")}
      onSelect={(o) => onChange(o.value)}
    />
  );
};
