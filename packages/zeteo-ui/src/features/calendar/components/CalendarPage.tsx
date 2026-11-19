import { faPlus, faTrash } from "@fortawesome/free-solid-svg-icons";
import { useCalendar, useSaveCalendar } from "../api/useCalendar";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ErrorNotice } from "@/components/ErrorNotice";
import type { Calendar, Holiday } from "../api/types";
import { PageHeader } from "@/components/PageHeader";
import { timeZoneOptions } from "./timeZones";
import { useAuth } from "@tereo-io/react";
import { useState } from "react";
import "./styles.css";
import {
  Alert,
  BorderedSection,
  Button,
  Input,
  Modal,
  SearchSelect,
  Spinner,
  Switch,
  TextArea,
} from "@kosmeo-ui/react";
import {
  isDate,
  mergeHolidays,
  parseHolidayLines,
  yearsToShow,
} from "./holidays";

const DAYS = [
  [1, "Monday"],
  [2, "Tuesday"],
  [3, "Wednesday"],
  [4, "Thursday"],
  [5, "Friday"],
  [6, "Saturday"],
  [7, "Sunday"],
] as const;

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const PasteDialog = ({
  onAdd,
  onClose,
}: {
  onAdd: (holidays: Holiday[]) => void;
  onClose: () => void;
}) => {
  const [text, setText] = useState("");
  const [bad, setBad] = useState<string[]>([]);
  const add = () => {
    const parsed = parseHolidayLines(text);
    setBad(parsed.bad);
    if (parsed.bad.length > 0) return;
    onAdd(parsed.holidays);
    onClose();
  };
  return (
    <Modal
      show
      title="Paste holidays"
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
        <Button
          key="add"
          fullWidth={false}
          disabled={!text.trim()}
          onClick={add}
        >
          Add holidays
        </Button>,
      ]}
    >
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
        Each line is a date as YYYY-MM-DD, a comma, and a name. A date already
        listed is replaced.
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
    </Modal>
  );
};

const CalendarForm = ({
  calendar,
  canWrite,
}: {
  calendar: Calendar;
  canWrite: boolean;
}) => {
  const save = useSaveCalendar();
  const [days, setDays] = useState(new Set(calendar.working_days));
  const [month, setMonth] = useState(calendar.fiscal_year_start_month);
  const [zone, setZone] = useState(calendar.time_zone);
  const [zones] = useState(() => timeZoneOptions(calendar.time_zone));
  const [holidays, setHolidays] = useState(calendar.holidays);
  const [date, setDate] = useState("");
  const [name, setName] = useState("");
  const [pasting, setPasting] = useState(false);
  const [saved, setSaved] = useState(false);

  const change =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      setSaved(false);
      set(v);
    };

  const toggle = (day: number) =>
    change(setDays)(
      new Set(
        days.has(day) ? [...days].filter((d) => d !== day) : [...days, day]
      )
    );
  const addOne = () => {
    if (!isDate(date) || !name.trim()) return;
    change(setHolidays)(mergeHolidays(holidays, [{ date, name: name.trim() }]));
    setDate("");
    setName("");
  };

  const years = yearsToShow(holidays);

  return (
    <div className="z-calendar">
      <BorderedSection title="Working days" as="h2">
        <div className="z-calendar-days">
          {DAYS.map(([n, label]) => (
            <Switch
              key={n}
              size="sm"
              label={label}
              checked={days.has(n)}
              disabled={!canWrite}
              onChange={() => toggle(n)}
            />
          ))}
        </div>
        {days.size === 0 && (
          <p role="alert" className="z-measure-field-error">
            Choose at least one working day.
          </p>
        )}
      </BorderedSection>

      <div className="z-calendar-row">
        <SearchSelect<string>
          label="Fiscal year starts in"
          value={MONTHS[month - 1] ?? null}
          options={MONTHS}
          getOptionLabel={(m) => m}
          getOptionKey={(m) => m}
          disabled={!canWrite}
          onSelect={(m) => change(setMonth)(MONTHS.indexOf(m) + 1)}
        />
        <SearchSelect<string>
          label="Time zone"
          placeholder="Search time zones"
          value={zone}
          options={zones}
          getOptionLabel={(z) => z}
          getOptionKey={(z) => z}
          disabled={!canWrite}
          longDropDown
          onSelect={change(setZone)}
        />
      </div>

      <BorderedSection
        title="Holidays"
        as="h2"
        actions={
          canWrite && (
            <Button
              size="sm"
              variant="secondary"
              fullWidth={false}
              onClick={() => setPasting(true)}
            >
              Paste holidays
            </Button>
          )
        }
      >
        {canWrite && (
          <div className="z-calendar-add">
            <Input
              label="Date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
            <Input
              label="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Button
              variant="success"
              fullWidth={false}
              title="Add holiday"
              aria-label="Add holiday"
              disabled={!isDate(date) || !name.trim()}
              onClick={addOne}
            >
              <FontAwesomeIcon icon={faPlus} />
            </Button>
          </div>
        )}
        {years.map((year) => {
          const inYear = holidays.filter((h) => h.date.startsWith(`${year}-`));
          return (
            <section key={year} aria-label={String(year)}>
              <h3>{year}</h3>
              {inYear.length === 0 ? (
                <p className="z-note">No holidays entered for {year}</p>
              ) : (
                <ul className="z-calendar-holidays">
                  {inYear.map((h) => (
                    <li key={h.date}>
                      <span className="z-calendar-date">{h.date}</span>
                      <span>{h.name}</span>
                      {canWrite && (
                        <Button
                          size="sm"
                          variant="danger"
                          fullWidth={false}
                          title="Remove"
                          aria-label={`Remove ${h.name}`}
                          onClick={() =>
                            change(setHolidays)(
                              holidays.filter((x) => x.date !== h.date)
                            )
                          }
                        >
                          <FontAwesomeIcon icon={faTrash} />
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </BorderedSection>

      {pasting && (
        <PasteDialog
          onAdd={(added) => change(setHolidays)(mergeHolidays(holidays, added))}
          onClose={() => setPasting(false)}
        />
      )}

      <ErrorNotice error={save.error} />
      {canWrite && (
        <div className="z-calendar-actions">
          <Button
            fullWidth={false}
            isLoading={save.isPending}
            disabled={save.isPending || days.size === 0}
            onClick={() =>
              save.mutate(
                {
                  working_days: [...days].sort((a, b) => a - b),
                  holidays,
                  fiscal_year_start_month: month,
                  time_zone: zone,
                },
                { onSuccess: () => setSaved(true) }
              )
            }
          >
            Save calendar
          </Button>
          {saved && <span className="z-muted">Saved.</span>}
        </div>
      )}
    </div>
  );
};

/** The install's one calendar: working days, holidays, fiscal year and time zone. Read-only without `zeteo.calendar.write`. */
export const CalendarPage = () => {
  const { hasPermission } = useAuth();
  const { data, error, isLoading } = useCalendar();
  return (
    <>
      <PageHeader
        title="Calendar"
        subtitle="Business days, the fiscal year and the time zone that relative dates and calendar functions follow."
      />
      {isLoading && <Spinner size="lg" />}
      <ErrorNotice error={error} />
      {data && (
        <CalendarForm
          calendar={data}
          canWrite={hasPermission("zeteo.calendar.write")}
        />
      )}
    </>
  );
};
