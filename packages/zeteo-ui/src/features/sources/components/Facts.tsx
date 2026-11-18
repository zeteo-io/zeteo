import { formatDuration } from "@/utils/formatDuration";
import { formatRelative } from "@/utils/formatRelative";
import { BorderedSection } from "@kosmeo-ui/react";
import { formatDate } from "@/utils/formatDate";
import { formatCount } from "./sourceLabels";
import type { Source } from "../api/types";
import type { ReactNode } from "react";
import "./styles.css";

export type Row = [string, ReactNode];

/** A source's facts, term and value, as its overview shows them. */
export const Facts = ({ rows }: { rows: Row[] }) => (
  <dl className="z-source-facts">
    {rows.map(([term, value]) => (
      <div key={term} style={{ display: "contents" }}>
        <dt>{term}</dt>
        <dd>{value}</dd>
      </div>
    ))}
  </dl>
);

export const When = ({ iso }: { iso: string | null }) =>
  iso ? (
    <time dateTime={iso} title={formatDate(iso)}>
      {formatRelative(iso)}
    </time>
  ) : (
    <>—</>
  );

const timeLimit = (ms: number) =>
  ms % 60_000 === 0 ? `${ms / 60_000} min` : formatDuration(ms);

const rowCount = (n: number) => `${formatCount(n)} ${n === 1 ? "row" : "rows"}`;

/** A source's Querying and Exports limits, the same for every type of source; Edit in the header changes them. */
export const LimitSections = ({ source }: { source: Source }) => {
  const exportRows: Row[] = source.export_enabled
    ? [
        ["Exports", "On"],
        ["Row cap", rowCount(source.export_row_cap)],
        ["Exports at once", formatCount(source.export_concurrency)],
      ]
    : [["Exports", "Off"]];

  return (
    <>
      <BorderedSection title="Querying" as="h2">
        <Facts
          rows={[
            ["Time limit", timeLimit(source.timeout_ms)],
            ["Row cap", rowCount(source.row_cap)],
            ["Queries at once", formatCount(source.query_concurrency)],
          ]}
        />
      </BorderedSection>
      <BorderedSection title="Exports" as="h2">
        <Facts rows={exportRows} />
      </BorderedSection>
    </>
  );
};
