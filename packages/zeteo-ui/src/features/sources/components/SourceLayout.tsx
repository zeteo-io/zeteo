import { NavLink, Outlet, useOutletContext, useParams } from "react-router-dom";
import { ErrorNotice } from "@/components/ErrorNotice";
import { PageHeader } from "@/components/PageHeader";
import { useSourceActions } from "./SourceActions";
import { useUuidParam } from "@/lib/useUuidParam";
import { NotFound } from "@/components/NotFound";
import { sourceTypeName } from "./sourceLabels";
import { SourceStatus } from "./SourceStatus";
import { useSource } from "../api/useSource";
import { Spinner } from "@kosmeo-ui/react";
import type { Source } from "../api/types";
import "./styles.css";

export interface SourceContext {
  source: Source;
}

/** The source the surrounding `SourceLayout` loaded. */
export const useSourceContext = () => useOutletContext<SourceContext>();

const TABS = [
  { to: "", label: "Overview", end: true },
  { to: "tables", label: "Tables", end: false },
  { to: "relations", label: "Relations", end: false },
];

/**
 * Loads one source and gives its pages a header and tabs. An id that is not
 * a UUID, here or a table's below, is not found, and zeteo is not asked.
 */
export const SourceLayout = () => {
  const sourceId = useUuidParam("sourceId");
  const rawTableId = useParams().tableId;
  const tableId = useUuidParam("tableId");
  if (!sourceId || (rawTableId !== undefined && !tableId)) return <NotFound />;
  return <SourceLoader sourceId={sourceId} />;
};

const SourceLoader = ({ sourceId }: { sourceId: string }) => {
  const { data: source, error, isLoading } = useSource(sourceId);

  if (isLoading) return <Spinner size="lg" />;
  if (!source) return <ErrorNotice error={error} />;

  return <SourceShell source={source} />;
};

const SourceShell = ({ source }: { source: Source }) => {
  const { actions, results } = useSourceActions(source);
  return (
    <>
      <div className="z-source-header">
        <PageHeader
          title={source.name}
          badges={
            <span className="z-source-subtitle">
              <code>{source.slug}</code>
              <span>{sourceTypeName(source.type)}</span>
              <SourceStatus source={source} />
            </span>
          }
          actions={actions}
          divider={false}
        />
      </div>
      {results}
      <nav className="z-source-tabs" aria-label="Source">
        {TABS.map((tab) => (
          <NavLink
            key={tab.label}
            to={`/sources/${source.id}${tab.to ? `/${tab.to}` : ""}`}
            end={tab.end}
            className="z-source-tab"
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>
      <Outlet context={{ source } satisfies SourceContext} />
    </>
  );
};
