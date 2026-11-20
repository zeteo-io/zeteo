import { Alert, Button, Input, Modal, TextArea } from "@kosmeo-ui/react";
import { faPlus, faTrash } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { isDate, parseHolidayLines } from "./holidays";
import type { Holiday } from "../api/types";
import { useState } from "react";

type Mode = "rows" | "paste";
const MODES: [Mode, string][] = [
  ["rows", "One by one"],
  ["paste", "Paste a list"],
];

interface Row {
  key: number;
  date: string;
  name: string;
}

let nextKey = 0;
const emptyRow = (): Row => ({ key: nextKey++, date: "", name: "" });
const blank = (r: Row) => !r.date && !r.name.trim();
const complete = (r: Row) =>
  isDate(r.date) && !!r.name.trim() && r.name.trim().length <= 200;

/** Adding holidays: typed in one row each, or pasted as `date,name` lines. A date already listed is replaced. */
export const AddHolidaysDialog = ({
  onAdd,
  onClose,
}: {
  onAdd: (holidays: Holiday[]) => void;
  onClose: () => void;
}) => {
  const [mode, setMode] = useState<Mode>("rows");
  const [rows, setRows] = useState<Row[]>(() => [emptyRow()]);
  const [text, setText] = useState("");
  const [bad, setBad] = useState<string[]>([]);
  const [checked, setChecked] = useState(false);

  const filled = rows.filter((r) => !blank(r));
  const setRow = (key: number, change: Partial<Row>) =>
    setRows(rows.map((r) => (r.key === key ? { ...r, ...change } : r)));

  const ready = mode === "rows" ? filled.length > 0 : !!text.trim();

  const add = () => {
    if (mode === "paste") {
      const parsed = parseHolidayLines(text);
      setBad(parsed.bad);
      if (parsed.bad.length > 0) return;
      onAdd(parsed.holidays);
      return onClose();
    }
    setChecked(true);
    if (!filled.every(complete)) return;
    onAdd(filled.map((r) => ({ date: r.date, name: r.name.trim() })));
    onClose();
  };

  return (
    <Modal
      show
      title="Add holidays"
      onClose={onClose}
      footerButtons={[
        <Button
          key="cancel"
          variant="secondary"
          fullWidth={false}
          onClick={onClose}
        >
          Cancel
        </Button>,
        <Button key="add" fullWidth={false} disabled={!ready} onClick={add}>
          Add
        </Button>,
      ]}
    >
      <div className="z-holidays-dialog">
        <div className="z-segmented" role="group" aria-label="How to add">
          {MODES.map(([m, label]) => (
            <button
              key={m}
              type="button"
              className="z-segmented-option"
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
            >
              {label}
            </button>
          ))}
        </div>

        {mode === "rows" ? (
          <>
            <div className="z-holiday-rows">
              {rows.map((r, i) => {
                const wrong = checked && !blank(r) && !complete(r);
                return (
                  <div key={r.key} className="z-holiday-row">
                    <Input
                      label={i === 0 ? "Date" : undefined}
                      aria-label={`Date ${i + 1}`}
                      type="date"
                      value={r.date}
                      onChange={(e) => setRow(r.key, { date: e.target.value })}
                    />
                    <Input
                      label={i === 0 ? "Name" : undefined}
                      aria-label={`Name ${i + 1}`}
                      value={r.name}
                      onChange={(e) => setRow(r.key, { name: e.target.value })}
                    />
                    <Button
                      variant="danger"
                      fullWidth={false}
                      title="Remove row"
                      aria-label={`Remove row ${i + 1}`}
                      disabled={rows.length === 1}
                      onClick={() =>
                        setRows(rows.filter((x) => x.key !== r.key))
                      }
                    >
                      <FontAwesomeIcon icon={faTrash} />
                    </Button>
                    {wrong && (
                      <p className="z-measure-field-error z-holiday-row-error">
                        Give a date and a name (up to 200 characters).
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
            <div>
              <Button
                size="sm"
                variant="success"
                fullWidth={false}
                onClick={() => setRows([...rows, emptyRow()])}
              >
                <FontAwesomeIcon icon={faPlus} /> Another holiday
              </Button>
            </div>
          </>
        ) : (
          <>
            <TextArea
              label="Holidays, one per line"
              rows={8}
              placeholder={
                "2027-01-01,New Year's Day\n2027-07-05,Independence Day (observed)"
              }
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <p className="z-muted">
              Each line is a date as YYYY-MM-DD, a comma, and a name.
            </p>
            {bad.length > 0 && (
              <Alert variant="danger">
                <p>These lines are not a date and a name:</p>
                <ul>
                  {bad.map((line, i) => (
                    <li key={i}>
                      <code>{line}</code>
                    </li>
                  ))}
                </ul>
              </Alert>
            )}
          </>
        )}
        <p className="z-muted">
          A date already listed is replaced. Nothing is kept until you save the
          calendar.
        </p>
      </div>
    </Modal>
  );
};
