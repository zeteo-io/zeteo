import { MAX_GRANT_COLUMNS } from "../api/types";
import "./styles.css";
import {
  Alert,
  Button,
  CheckboxGroup,
  RadioGroup,
  Spinner,
} from "@kosmeo-ui/react";

export interface ChooserColumn {
  id: string;
  name: string;
  missing: boolean;
}

export interface ColumnChoice {
  allColumns: boolean;
  selected: string[];
}

interface ColumnChooserProps {
  value: ColumnChoice;
  onChange: (value: ColumnChoice) => void;
  /** The columns that can be ticked; missing ones are those a grant still holds. */
  columns: ChooserColumn[];
  /** Why the columns cannot be listed, when they cannot. */
  unavailable?: string;
  /** The columns are still being read: the checklist waits for them. */
  loading?: boolean;
}

/** Whether a choice can be sent: every column, or 1 to 500 columns. */
export const isValidChoice = ({ allColumns, selected }: ColumnChoice) =>
  allColumns || (selected.length >= 1 && selected.length <= MAX_GRANT_COLUMNS);

export const ColumnChooser = ({
  value,
  onChange,
  columns,
  unavailable,
  loading = false,
}: ColumnChooserProps) => {
  const live = columns.filter((c) => !c.missing);
  const chosenCount = value.selected.length;
  return (
    <div>
      <RadioGroup
        label="Columns"
        name="grant-columns"
        value={value.allColumns ? "all" : "some"}
        onChange={(v) => onChange({ ...value, allColumns: v === "all" })}
        options={[
          { value: "all", label: "All columns" },
          { value: "some", label: "Choose columns" },
        ]}
      />
      {unavailable && <Alert variant="warning">{unavailable}</Alert>}
      {!value.allColumns && loading && <Spinner size="md" />}
      {!value.allColumns && !loading && (
        <>
          <div className="z-grant-columns-tools">
            <Button
              size="sm"
              variant="secondary"
              fullWidth={false}
              disabled={live.length === 0}
              onClick={() =>
                onChange({ ...value, selected: live.map((c) => c.id) })
              }
            >
              Select all
            </Button>
            <Button
              size="sm"
              variant="secondary"
              fullWidth={false}
              onClick={() => onChange({ ...value, selected: [] })}
            >
              Select none
            </Button>
            <span>
              {chosenCount} of {columns.length} columns chosen
            </span>
          </div>
          <CheckboxGroup
            name="grant-column-ids"
            values={value.selected}
            onChange={(selected) => {
              // Keep the order of the table, whatever order they were ticked in.
              const ticked = new Set(selected);
              onChange({
                ...value,
                selected: columns
                  .filter((c) => ticked.has(c.id))
                  .map((c) => c.id),
              });
            }}
            options={columns.map((c) => ({
              value: c.id,
              label: c.missing ? `${c.name} (missing)` : c.name,
            }))}
          />
          {chosenCount === 0 && (
            <p role="alert">
              Choose at least one column, or grant all columns.
            </p>
          )}
          {chosenCount > MAX_GRANT_COLUMNS && (
            <p role="alert">
              A grant lists at most {MAX_GRANT_COLUMNS} columns; grant all
              columns instead.
            </p>
          )}
        </>
      )}
    </div>
  );
};
