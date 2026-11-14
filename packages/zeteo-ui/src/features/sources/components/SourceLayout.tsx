import { NavLink, Outlet, useOutletContext, useParams } from "react-router-dom";
import { ErrorNotice } from "@/components/ErrorNotice";
import { PageHeader } from "@/components/PageHeader";
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

/** Loads one source and gives its pages a header and tabs. */
export const SourceLayout = () => {
  const { sourceId = "" } = useParams();
  const { data: source, error, isLoading } = useSource(sourceId);

  if (isLoading) return <Spinner size="lg" />;
  if (!source) return <ErrorNotice error={error} />;

  return (
    <>
      <PageHeader
        title={source.name}
        subtitle={source.slug}
        badges={<SourceStatus source={source} />}
      />
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
