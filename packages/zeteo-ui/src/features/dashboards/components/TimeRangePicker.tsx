import { TIME_RANGE_KEYS, type TimeRangeKey } from "../api/types";
import { TIME_RANGE_LABELS } from "../timeRanges";
import { SearchSelect } from "@kosmeo-ui/react";

interface Option {
  value: TimeRangeKey | null;
  label: string;
}

const OPTIONS: Option[] = [
  { value: null, label: "No time range" },
  ...TIME_RANGE_KEYS.map((k) => ({ value: k, label: TIME_RANGE_LABELS[k] })),
];

/** A relative time range, or none. */
export const TimeRangePicker = ({
  label = "Time range",
  value,
  onChange,
}: {
  label?: string;
  value: TimeRangeKey | null;
  onChange: (value: TimeRangeKey | null) => void;
}) => (
  <SearchSelect<Option>
    label={label}
    size="sm"
    value={OPTIONS.find((o) => o.value === value) ?? OPTIONS[0]}
    options={OPTIONS}
    getOptionLabel={(o) => o.label}
    getOptionKey={(o) => o.value ?? "none"}
    onSelect={(o) => onChange(o.value)}
  />
);
