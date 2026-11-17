import { formatCount, sourceTypeName, tlsName } from "./sourceLabels";
import { Alert, BorderedSection } from "@kosmeo-ui/react";
import { formatDuration } from "@/utils/formatDuration";
import { formatRelative } from "@/utils/formatRelative";
import { useSourceContext } from "./SourceLayout";
import { formatDate } from "@/utils/formatDate";
import type { ReactNode } from "react";
import "./styles.css";

type Row = [string, ReactNode];

const Facts = ({ rows }: { rows: Row[] }) => (
  <dl className="z-source-facts">
    {rows.map(([term, value]) => (
      <div key={term} style={{ display: "contents" }}>
        <dt>{term}</dt>
        <dd>{value}</dd>
      </div>
    ))}
  </dl>
);

const When = ({ iso }: { iso: string | null }) =>
  iso ? <time title={formatDate(iso)}>{formatRelative(iso)}</time> : <>—</>;

const timeLimit = (ms: number) =>
  ms % 60_000 === 0 ? `${ms / 60_000} min` : formatDuration(ms);

const rowCount = (n: number) => `${formatCount(n)} ${n === 1 ? "row" : "rows"}`;

export const SourceDetailPage = () => {
  const { source } = useSourceContext();
  const settings = source.settings;

  const exportRows: Row[] = source.export_enabled
    ? [
        ["Exports", "On"],
        ["Row cap", rowCount(source.export_row_cap)],
        ["Exports at once", formatCount(source.export_concurrency)],
      ]
    : [["Exports", "Off"]];

  const catalogueRows: Row[] = [
    [
      "Schemas",
      <span className="z-source-chips">
        {source.schemas.map((s) => (
          <span key={s} className="z-source-chip">
            {s}
          </span>
        ))}
      </span>,
    ],
    ["Last refreshed", <When iso={source.last_refreshed_at} />],
    ["Added", <When iso={source.created_at} />],
  ];
  if (source.archived_at) {
    catalogueRows.push(["Archived", <When iso={source.archived_at} />]);
  }

  return (
    <div className="z-source-overview">
      <div className="z-source-column">
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
        <BorderedSection title="Catalogue" as="h2">
          <Facts rows={catalogueRows} />
        </BorderedSection>
      </div>
      <div className="z-source-column">
        <BorderedSection title="Connection" as="h2">
          {settings === null ? (
            <Alert variant="warning">
              The stored connection settings are unreadable. Change the
              connection to replace them.
            </Alert>
          ) : (
            <Facts
              rows={[
                ["Database type", sourceTypeName(source.type)],
                ["Host", String(settings.host ?? "—")],
                ["Port", String(settings.port ?? "Default")],
                ["Database", String(settings.database ?? "—")],
                ["User", String(settings.user ?? "—")],
                ["TLS", tlsName(settings.tls)],
                [
                  "Writable login",
                  source.writable_login_allowed ? "Allowed" : "Not allowed",
                ],
              ]}
            />
          )}
        </BorderedSection>
      </div>
    </div>
  );
};
