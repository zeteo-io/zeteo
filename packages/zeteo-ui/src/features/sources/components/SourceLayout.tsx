import { useUploadActions } from "../upload/components/UploadActions";
import { useSourceAccess, type SourceAccess } from "./access";
import { sourceHref, sourceTypeName } from "./sourceLabels";
import { SourceFrame, type SourceTab } from "./SourceFrame";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Outlet, useParams } from "react-router-dom";
import { useSourceActions } from "./SourceActions";
import { useUuidParam } from "@/lib/useUuidParam";
import { NotFound } from "@/components/NotFound";
import type { SourceContext } from "./context";
import { SourceStatus } from "./SourceStatus";
import { useSource } from "../api/useSource";
import { Spinner } from "@kosmeo-ui/react";
import type { Source } from "../api/types";
import "./styles.css";

export { useSourceContext, type SourceContext } from "./context";

const TABS: SourceTab[] = [
  { to: "", label: "Overview" },
  { to: "tables", label: "Tables" },
  { to: "relations", label: "Relations" },
  { to: "sharing", label: "Shared with" },
];

/**
 * Loads one source, of any type, and gives its pages a header and tabs. An
 * id that is not a UUID, here or a table's below, is not found, and zeteo is
 * not asked.
 */
export const SourceLayout = () => {
  const sourceId = useUuidParam("sourceId");
  const rawTableId = useParams().tableId;
  const tableId = useUuidParam("tableId");
  if (!sourceId || (rawTableId !== undefined && !tableId)) return <NotFound />;
  return <SourceLoader key={sourceId} sourceId={sourceId} />;
};

const SourceLoader = ({ sourceId }: { sourceId: string }) => {
  const { data: source, error, isLoading } = useSource(sourceId);

  if (isLoading) return <Spinner size="lg" />;
  if (!source) return <ErrorNotice error={error} />;

  return source.type === "upload" ? (
    <UploadShell source={source} />
  ) : (
    <DatabaseShell source={source} />
  );
};

interface ShellProps {
  source: Source;
  access: SourceAccess;
  actions: React.ReactNode;
  notices: React.ReactNode;
}

const Shell = ({ source, access, actions, notices }: ShellProps) => (
  <SourceFrame
    baseHref={sourceHref(source.id)}
    name={source.name}
    description={source.description}
    slug={source.slug}
    kind={sourceTypeName(source.type)}
    status={<SourceStatus source={source} />}
    actions={actions}
    notices={notices}
    tabs={TABS.filter((t) => t.to !== "sharing" || access.canSeeSharing)}
  >
    <Outlet context={{ source, access } satisfies SourceContext} />
  </SourceFrame>
);

const DatabaseShell = ({ source }: { source: Source }) => {
  const access = useSourceAccess(source);
  const { actions, results } = useSourceActions(source);
  return (
    <Shell
      source={source}
      access={access}
      actions={actions}
      notices={results}
    />
  );
};

const UploadShell = ({ source }: { source: Source }) => {
  const access = useSourceAccess(source);
  const { actions, dialogs } = useUploadActions(source, access);
  return (
    <Shell
      source={source}
      access={access}
      actions={actions}
      notices={dialogs}
    />
  );
};
