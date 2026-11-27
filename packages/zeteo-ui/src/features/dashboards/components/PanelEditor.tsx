import { useAvailableSavedQueries } from "../api/useAvailableSavedQueries";
import type { ChartSettings, ChartType, SavedPanel } from "../api/types";
import { RowsLimitedPill } from "@/components/RowsLimitedPill";
import { useCatalogColumns } from "../api/useCatalogColumns";
import { ErrorNotice } from "@/components/ErrorNotice";
import { useSavedPanels } from "../api/useSavedPanels";
import { toApiError, type ApiError } from "@/lib/api";
import { useEffect, useMemo, useState } from "react";
import { usePreview } from "../api/usePreview";
import { Chart } from "../charts/Chart";
import "./styles.css";
import {
  useMySavedQueries,
  useSavedQuery,
  type SavedQuery,
} from "@/features/saved-queries";
import {
  Button,
  Input,
  Modal,
  SearchSelect,
  Spinner,
  TextArea,
} from "@kosmeo-ui/react";
import {
  ChartFields,
  CHART_TYPES,
  Setting,
  problemsByField,
} from "./ChartFields";
import {
  bucketColumn,
  defaultChart,
  suggestChart,
  timeColumnOptions,
} from "../editing";

/** What the editor hands back: an own panel's settings, or a saved panel to link. */
export type EditorValue =
  | {
      kind: "own";
      saved_query_id: string;
      chart: ChartSettings;
      time_column?: string;
      title?: string;
      name?: string;
      description?: string;
    }
  | { kind: "linked"; saved_panel_id: string; title?: string };

export interface EditorInitial {
  kind?: "own" | "linked";
  saved_query_id?: string;
  saved_panel_id?: string;
  chart?: ChartSettings;
  time_column?: string;
  title?: string;
  name?: string;
  description?: string;
}

interface PanelEditorProps {
  heading: string;
  submitLabel: string;
  /** A dashboard's panel (an optional title) or a saved panel (a name and description). */
  purpose: "dashboard" | "saved_panel";
  /** A new panel may link a saved panel instead. */
  allowLinked?: boolean;
  initial?: EditorInitial;
  /** Saves; a rejection (an `ApiError`) stays in the editor, its problems beside their fields. */
  onSubmit: (value: EditorValue) => Promise<unknown>;
  onClose: () => void;
}

interface TimeOption {
  value: string | null;
  label: string;
}

const NO_TIME: TimeOption = { value: null, label: "No time column" };

/** Leaves out the settings left empty, so the server sees only what was set. */
const cleanChart = (chart: ChartSettings): ChartSettings =>
  Object.fromEntries(
    Object.entries(chart).filter(([, v]) => v !== undefined && v !== "")
  ) as unknown as ChartSettings;

const byName = <T extends { name: string }>(a: T, b: T) =>
  a.name.localeCompare(b.name);

/**
 * The panel editor: pick a saved query (yours, or one available for
 * dashboards) or a saved panel, choose a chart (suggested from the result's
 * column types) and a time column (the saved query's reachable date and
 * timestamp columns), and see it live.
 */
export const PanelEditor = ({
  heading,
  submitLabel,
  purpose,
  allowLinked = false,
  initial = {},
  onSubmit,
  onClose,
}: PanelEditorProps) => {
  const [kind, setKind] = useState<"own" | "linked">(initial.kind ?? "own");
  const [queryId, setQueryId] = useState(initial.saved_query_id ?? null);
  const [panelId, setPanelId] = useState(initial.saved_panel_id ?? null);
  const [chart, setChart] = useState<ChartSettings | null>(
    initial.chart ?? null
  );
  const [timeColumn, setTimeColumn] = useState<string | null | undefined>(
    initial.kind === "own" || initial.chart
      ? (initial.time_column ?? null)
      : undefined
  );
  const [title, setTitle] = useState(initial.title ?? "");
  const [name, setName] = useState(initial.name ?? "");
  const [description, setDescription] = useState(initial.description ?? "");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);

  const linking = kind === "linked";
  const mine = useMySavedQueries();
  const available = useAvailableSavedQueries();
  const myPanels = useSavedPanels("mine");
  const sharedPanels = useSavedPanels("shared");
  const picked = useSavedQuery(queryId ?? "");
  const savedQuery = queryId ? picked.data : undefined;
  const catalog = useCatalogColumns(!linking && !!savedQuery?.source);

  const queryOptions = useMemo(() => {
    const seen = new Set<string>();
    const list: SavedQuery[] = [];
    for (const sq of [...mine.items, ...available.items]) {
      if (!seen.has(sq.id)) {
        seen.add(sq.id);
        list.push(sq);
      }
    }
    if (savedQuery && !seen.has(savedQuery.id)) list.push(savedQuery);
    return list.sort(byName);
  }, [mine.items, available.items, savedQuery]);

  const mineIds = new Set(mine.items.map((q) => q.id));
  const myPanelIds = new Set(myPanels.items.map((p) => p.id));

  const panelOptions = useMemo(
    () =>
      [...myPanels.items, ...sharedPanels.items]
        .filter((p) => p.state === "ok")
        .sort(byName),
    [myPanels.items, sharedPanels.items]
  );
  const linkedPanel = panelOptions.find((p) => p.id === panelId) ?? null;

  const preview = usePreview(
    linking
      ? panelId
        ? { kind: "saved_panel", id: panelId }
        : null
      : queryId
        ? { kind: "saved_query", id: queryId }
        : null
  );
  const columns = useMemo(() => preview.data?.columns ?? [], [preview.data]);

  const timeOptions = useMemo(
    () =>
      timeColumnOptions(
        savedQuery?.query,
        catalog.data?.find((s) => s.slug === savedQuery?.source?.slug)
      ),
    [savedQuery, catalog.data]
  );

  // A new saved query's first chart: the one its result suggests.
  useEffect(() => {
    if (linking || chart !== null || !preview.data) return;
    const type = suggestChart(preview.data.columns, preview.data.rows.length);
    setChart(defaultChart(type, preview.data.columns));
  }, [linking, chart, preview.data]);

  // Its first time column: the one behind a date bucket, when it can be used.
  useEffect(() => {
    if (linking || timeColumn !== undefined || !savedQuery || !catalog.data) {
      return;
    }
    const behind = bucketColumn(savedQuery.query);
    setTimeColumn(behind && timeOptions.includes(behind) ? behind : null);
  }, [linking, timeColumn, savedQuery, catalog.data, timeOptions]);

  const pickQuery = (sq: SavedQuery) => {
    if (sq.id === queryId) return;
    setQueryId(sq.id);
    setChart(null);
    setTimeColumn(undefined);
    setFailure(null);
  };

  const problems = problemsByField(failure?.problems);
  const linkedChart = linking ? linkedPanel?.chart : undefined;
  const shown = linking ? linkedChart : chart;

  const ready = linking ? panelId !== null : queryId !== null && chart !== null;
  const named = purpose === "dashboard" || name.trim() !== "";

  const submit = async () => {
    const trimmedTitle = title.trim();
    const value: EditorValue = linking
      ? {
          kind: "linked",
          saved_panel_id: panelId!,
          ...(trimmedTitle && { title: trimmedTitle }),
        }
      : {
          kind: "own",
          saved_query_id: queryId!,
          chart: cleanChart(chart!),
          ...(timeColumn && { time_column: timeColumn }),
          ...(purpose === "dashboard" &&
            trimmedTitle && { title: trimmedTitle }),
          ...(purpose === "saved_panel" && {
            name: name.trim(),
            description,
          }),
        };
    setBusy(true);
    setFailure(null);
    try {
      await onSubmit(value);
      onClose();
    } catch (err) {
      setFailure(toApiError(err));
    } finally {
      setBusy(false);
    }
  };

  const timeChoices: TimeOption[] = [
    NO_TIME,
    ...timeOptions.map((c) => ({ value: c, label: c })),
  ];
  const timeChosen =
    timeChoices.find((o) => o.value === (timeColumn ?? null)) ??
    (timeColumn ? { value: timeColumn, label: timeColumn } : NO_TIME);

  return (
    <Modal
      show
      title={heading}
      size="lg"
      onClose={onClose}
      dismissible={!busy}
      footerButtons={[
        <Button
          key="cancel"
          variant="secondary"
          fullWidth={false}
          disabled={busy}
          onClick={onClose}
        >
          Cancel
        </Button>,
        <Button
          key="submit"
          fullWidth={false}
          isLoading={busy}
          disabled={busy || !ready || !named}
          onClick={() => void submit()}
        >
          {submitLabel}
        </Button>,
      ]}
    >
      <div className="z-pe">
        <div className="z-pe-form">
          {purpose === "saved_panel" && (
            <>
              <Setting name="name" problems={problems}>
                <Input
                  label="Name"
                  value={name}
                  max={100}
                  onChange={(e) => setName(e.target.value)}
                />
              </Setting>
              <TextArea
                label="Description"
                value={description}
                max={2000}
                onChange={(e) => setDescription(e.target.value)}
              />
            </>
          )}
          {allowLinked && (
            <div
              className="z-pe-kind"
              role="group"
              aria-label="What the panel shows"
            >
              {(["own", "linked"] as const).map((k) => (
                <Button
                  key={k}
                  size="sm"
                  variant={kind === k ? "primary" : "secondary"}
                  fullWidth={false}
                  aria-pressed={kind === k}
                  onClick={() => {
                    setKind(k);
                    setFailure(null);
                  }}
                >
                  {k === "own" ? "Saved query" : "Saved panel"}
                </Button>
              ))}
            </div>
          )}
          {linking ? (
            <Setting name="saved_panel" problems={problems}>
              <SearchSelect<SavedPanel>
                label="Saved panel"
                value={linkedPanel}
                options={panelOptions}
                getOptionLabel={(p) => p.name}
                getOptionKey={(p) => p.id}
                renderOption={(p) =>
                  myPanelIds.has(p.id) ? (
                    p.name
                  ) : (
                    <span>
                      {p.name}{" "}
                      <span className="z-muted">{p.owner.name ?? ""}</span>
                    </span>
                  )
                }
                disabled={!allowLinked && initial.kind === "linked"}
                onSelect={(p) => {
                  setPanelId(p.id);
                  setFailure(null);
                }}
              />
            </Setting>
          ) : (
            <Setting name="saved_query" problems={problems}>
              <SearchSelect<SavedQuery>
                label="Saved query"
                value={queryOptions.find((q) => q.id === queryId) ?? null}
                options={queryOptions}
                getOptionLabel={(q) => q.name}
                getOptionKey={(q) => q.id}
                renderOption={(q) =>
                  mineIds.has(q.id) ? (
                    q.name
                  ) : (
                    <span>
                      {q.name}{" "}
                      <span className="z-muted">{q.owner.name ?? ""}</span>
                    </span>
                  )
                }
                onSelect={pickQuery}
              />
            </Setting>
          )}
          {purpose === "dashboard" && (
            <Setting name="title" problems={problems}>
              <Input
                label="Title (optional)"
                value={title}
                max={100}
                onChange={(e) => setTitle(e.target.value)}
              />
            </Setting>
          )}
          {!linking && chart && (
            <>
              <Setting name="type" problems={problems}>
                <SearchSelect<{ value: ChartType; label: string }>
                  label="Chart type"
                  value={CHART_TYPES.find((t) => t.value === chart.type)!}
                  options={CHART_TYPES}
                  getOptionLabel={(t) => t.label}
                  getOptionKey={(t) => t.value}
                  onSelect={(t) => setChart(defaultChart(t.value, columns))}
                />
              </Setting>
              <Setting name="time_column" problems={problems}>
                <SearchSelect<TimeOption>
                  label="Time column"
                  value={timeChosen}
                  options={timeChoices}
                  getOptionLabel={(o) => o.label}
                  getOptionKey={(o) => o.value ?? ""}
                  onSelect={(o) => setTimeColumn(o.value)}
                />
              </Setting>
              <ChartFields
                chart={chart}
                columns={columns}
                problems={problems}
                onChange={setChart}
              />
            </>
          )}
          {failure && !failure.problems?.length && (
            <ErrorNotice error={failure} />
          )}
          {failure?.problems?.length ? (
            <p className="z-pe-problem">{failure.message}</p>
          ) : null}
        </div>
        <div className="z-pe-preview" aria-label="Preview">
          {preview.isFetching && <Spinner size="sm" />}
          <ErrorNotice error={preview.error} />
          {preview.data?.rows_limited && <RowsLimitedPill />}
          {preview.data && shown && (
            <div className="z-pe-chart">
              <Chart chart={shown} result={preview.data} />
            </div>
          )}
          {!preview.data && !preview.isFetching && !preview.error && (
            <p className="z-note">
              {linking
                ? "Pick a saved panel to see it here."
                : "Pick a saved query to see it here."}
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
};
