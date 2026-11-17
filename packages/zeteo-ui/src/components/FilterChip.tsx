import type { ReactNode } from "react";

interface FilterChipProps {
  children: ReactNode;
  /** The clear button's accessible name, e.g. "Clear source". */
  clearLabel: string;
  onClear: () => void;
}

/** An applied filter as a removable chip in a list's toolbar. */
export const FilterChip = ({
  children,
  clearLabel,
  onClear,
}: FilterChipProps) => (
  <span className="z-filter-chip">
    {children}
    <button
      type="button"
      className="z-chip-clear"
      aria-label={clearLabel}
      onClick={onClear}
    >
      ×
    </button>
  </span>
);
