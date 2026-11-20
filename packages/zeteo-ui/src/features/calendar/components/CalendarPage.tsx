import type { Calendar, CalendarBody, Holiday } from "../api/types";
import { useCalendar, useSaveCalendar } from "../api/useCalendar";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faTrash } from "@fortawesome/free-solid-svg-icons";
import { AddHolidaysDialog } from "./AddHolidaysDialog";
import { mergeHolidays, yearsToShow } from "./holidays";
import { ErrorNotice } from "@/components/ErrorNotice";
import { PageHeader } from "@/components/PageHeader";
import { useState, type ReactNode } from "react";
import { timeZoneOptions } from "./timeZones";
import { useAuth } from "@tereo-io/react";
import "./styles.css";
import {
  BorderedSection,
  Button,
  EmptyState,
  RowActions,
  SearchSelect,
  Spinner,
  Switch,
  Table,
} from "@kosmeo-ui/react";

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

/** "Mon", "Tue", …: the weekday of a calendar day. */
const weekday = (date: string) =>
  new Date(`${date}T00:00:00.000Z`).toLocaleDateString(undefined, {
    weekday: "short",
    timeZone: "UTC",
  });

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
  const [adding, setAdding] = useState(false);
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
  const body: CalendarBody = {
    working_days: [...days].sort((a, b) => a - b),
    holidays: [...holidays].sort((a, b) => a.date.localeCompare(b.date)),
    fiscal_year_start_month: month,
    time_zone: zone,
  };
  // Saved as it is: the calendar the server last returned.
  const stored: CalendarBody = {
    working_days: [...calendar.working_days].sort((a, b) => a - b),
    holidays: [...calendar.holidays].sort((a, b) =>
      a.date.localeCompare(b.date)
    ),
    fiscal_year_start_month: calendar.fiscal_year_start_month,
    time_zone: calendar.time_zone,
  };
  const changed = JSON.stringify(body) !== JSON.stringify(stored);
  // With none at all, the table says so; otherwise the years still to fill.
  const emptyYears = (
    holidays.length === 0 ? [] : yearsToShow(holidays)
  ).filter((year) => !holidays.some((h) => h.date.startsWith(`${year}-`)));

  return (
    <>
      <CalendarHeader
        actions={
          canWrite && (
            <div className="z-header-actions">
              {saved && !changed && <span className="z-muted">Saved</span>}
              <Button
                size="sm"
                fullWidth={false}
                isLoading={save.isPending}
                disabled={!changed || save.isPending || days.size === 0}
                onClick={() =>
                  save.mutate(body, { onSuccess: () => setSaved(true) })
                }
              >
                Save calendar
              </Button>
            </div>
          )
        }
      />
      <ErrorNotice error={save.error} />
      <div className="z-calendar">
        <div className="z-calendar-column">
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

          <BorderedSection title="Fiscal year and time zone" as="h2">
            <div className="z-calendar-fields">
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
          </BorderedSection>
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
                onClick={() => setAdding(true)}
              >
                Add holidays
              </Button>
            )
          }
        >
          <div className={canWrite ? "z-wrap z-actions-last" : "z-wrap"}>
            <Table<Holiday>
              rowKey={(h) => h.date}
              emptyMessage={<EmptyState>No holidays yet.</EmptyState>}
              columns={[
                {
                  title: "Date",
                  width: "1%",
                  cellElement: (h) => (
                    <span className="z-calendar-date">{h.date}</span>
                  ),
                },
                {
                  title: "Day",
                  width: "1%",
                  cellElement: (h) => weekday(h.date),
                },
                { title: "Name", cellElement: (h) => h.name },
                ...(canWrite
                  ? [
                      {
                        title: "",
                        cellElement: (h: Holiday) => (
                          <RowActions align="end">
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
                          </RowActions>
                        ),
                      },
                    ]
                  : []),
              ]}
              rows={body.holidays}
            />
          </div>
          {emptyYears.map((year) => (
            <p key={year} className="z-note">
              No holidays entered for {year}
            </p>
          ))}
        </BorderedSection>
      </div>

      {adding && (
        <AddHolidaysDialog
          onAdd={(added) => change(setHolidays)(mergeHolidays(holidays, added))}
          onClose={() => setAdding(false)}
        />
      )}
    </>
  );
};

const CalendarHeader = ({ actions }: { actions?: ReactNode }) => (
  <PageHeader
    title="Calendar"
    subtitle="Business days, the fiscal year and the time zone that relative dates and calendar functions follow."
    actions={actions}
  />
);

/** The install's one calendar: working days, holidays, fiscal year and time zone. Read-only without `zeteo.calendar.write`. */
export const CalendarPage = () => {
  const { hasPermission } = useAuth();
  const { data, error, isLoading } = useCalendar();
  if (!data)
    return (
      <>
        <CalendarHeader />
        {isLoading && <Spinner size="lg" />}
        <ErrorNotice error={error} />
      </>
    );
  return (
    <CalendarForm
      calendar={data}
      canWrite={hasPermission("zeteo.calendar.write")}
    />
  );
};
