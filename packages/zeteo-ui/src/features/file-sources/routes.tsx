import { NoAccessSection } from "@/components/NoAccessSection";
import { useFileSourcesEnabled } from "@/lib/useUiConfig";
import { Suspense, lazy, type ReactNode } from "react";
import { NotFound } from "@/components/NotFound";
import { Spinner } from "@kosmeo-ui/react";
import { useAuth } from "@tereo-io/react";

const AddDataPage = lazy(() =>
  import("./components/AddDataPage").then((m) => ({ default: m.AddDataPage }))
);
const AddTablesPage = lazy(() =>
  import("./components/AddDataPage").then((m) => ({
    default: m.AddTablesPage,
  }))
);
const ReuploadPage = lazy(() =>
  import("./components/AddDataPage").then((m) => ({ default: m.ReuploadPage }))
);
const FileSourcePage = lazy(() =>
  import("./components/FileSourcePage").then((m) => ({
    default: m.FileSourcePage,
  }))
);

export const FILE_SOURCES_WRITE = "zeteo.file_sources.write";

/**
 * File Sources' pages: only while the server has them on, and only for one
 * of `permissions` (an owner's `zeteo.file_sources.write`, or an admin's).
 */
const Guard = ({
  permissions,
  children,
}: {
  permissions: string[];
  children: ReactNode;
}) => {
  const { hasPermission } = useAuth();
  const enabled = useFileSourcesEnabled();
  if (enabled === undefined) return <Spinner size="lg" />;
  if (!enabled) return <NotFound />;
  if (!permissions.some((p) => hasPermission(p))) {
    return <NoAccessSection permission={permissions[0]!} />;
  }
  return <Suspense fallback={<Spinner size="lg" />}>{children}</Suspense>;
};

const OWNER = [FILE_SOURCES_WRITE];
// The service decides per source: its owner, or an admin.
const MANAGE = [FILE_SOURCES_WRITE, "zeteo.sources.read"];
const CHANGE = [FILE_SOURCES_WRITE, "zeteo.sources.write"];

/** A file source's pages, under My Zeteo. */
export const fileSourceRoutes = [
  {
    path: "/my/data/new",
    element: (
      <Guard permissions={OWNER}>
        <AddDataPage />
      </Guard>
    ),
  },
  {
    path: "/my/data/:fileSourceId",
    element: (
      <Guard permissions={MANAGE}>
        <FileSourcePage />
      </Guard>
    ),
  },
  {
    path: "/my/data/:fileSourceId/add",
    element: (
      <Guard permissions={CHANGE}>
        <AddTablesPage />
      </Guard>
    ),
  },
  {
    path: "/my/data/:fileSourceId/tables/:tableId/reupload",
    element: (
      <Guard permissions={CHANGE}>
        <ReuploadPage />
      </Guard>
    ),
  },
];
