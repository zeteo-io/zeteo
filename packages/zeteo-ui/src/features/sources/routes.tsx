import { RequirePermission } from "@/components/RequirePermission";
import { NoAccessSection } from "@/components/NoAccessSection";
import { useFileSourcesEnabled } from "@/lib/useUiConfig";
import { FILE_SOURCES_WRITE } from "./components/access";
import { Suspense, lazy, type ReactNode } from "react";
import { NotFound } from "@/components/NotFound";
import { Spinner } from "@kosmeo-ui/react";
import { useAuth } from "@tereo-io/react";

const SourceLayout = lazy(() =>
  import("./components/SourceLayout").then((m) => ({ default: m.SourceLayout }))
);
const SourceDetailPage = lazy(() =>
  import("./components/SourceDetailPage").then((m) => ({
    default: m.SourceDetailPage,
  }))
);
const SourceNewPage = lazy(() =>
  import("./components/SourceFormPages").then((m) => ({
    default: m.SourceNewPage,
  }))
);
const TablesPage = lazy(() =>
  import("./components/SourceTabs").then((m) => ({
    default: m.SourceTablesPage,
  }))
);
const TablePage = lazy(() =>
  import("./components/SourceTabs").then((m) => ({
    default: m.SourceTablePage,
  }))
);
const RelationsPage = lazy(() =>
  import("./components/SourceTabs").then((m) => ({
    default: m.SourceRelationsPage,
  }))
);
const SharingPage = lazy(() =>
  import("./components/SourceTabs").then((m) => ({
    default: m.SourceSharingPage,
  }))
);
const AddDataPage = lazy(() =>
  import("./upload/components/AddDataPage").then((m) => ({
    default: m.AddDataPage,
  }))
);
const AddTablesPage = lazy(() =>
  import("./upload/components/AddDataPage").then((m) => ({
    default: m.AddTablesPage,
  }))
);
const ReuploadPage = lazy(() =>
  import("./upload/components/AddDataPage").then((m) => ({
    default: m.ReuploadPage,
  }))
);

const READ = "zeteo.sources.read";
const WRITE = "zeteo.sources.write";

const loading = (page: ReactNode) => (
  <Suspense fallback={<Spinner size="lg" />}>{page}</Suspense>
);

const guarded = (permission: string, page: ReactNode) => (
  <RequirePermission permission={permission}>{loading(page)}</RequirePermission>
);

/**
 * Admits whoever holds one of `admin`, or, while File Sources are on, one
 * holding `zeteo.file_sources.write` (an upload's owner; zeteo decides which
 * sources are theirs). Anyone else sees what `admin[0]` would give them.
 */
const SourceGuard = ({
  admin,
  children,
}: {
  admin: string[];
  children: ReactNode;
}) => {
  const { hasPermission } = useAuth();
  const enabled = useFileSourcesEnabled();
  const asAdmin = admin.some((p) => hasPermission(p));
  const asOwner = hasPermission(FILE_SOURCES_WRITE);
  if (asAdmin) return loading(children);
  if (asOwner && enabled === undefined) return <Spinner size="lg" />;
  if (asOwner && enabled) return loading(children);
  return <NoAccessSection permission={admin[0]!} />;
};

/** Pages only File Sources have: not found while they are off. */
const UploadGuard = ({
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
  return loading(children);
};

// Changing an upload's tables: its owner, or a sources admin (zeteo decides).
const CHANGE_UPLOAD = [FILE_SOURCES_WRITE, WRITE];

/** A source's pages, of every type, beside the `/sources` list route; and Add data. */
export const sourceRoutes = [
  { path: "/sources/new", element: guarded(WRITE, <SourceNewPage />) },
  {
    path: "/sources/:sourceId",
    element: (
      <SourceGuard admin={[READ]}>
        <SourceLayout />
      </SourceGuard>
    ),
    children: [
      { index: true, element: loading(<SourceDetailPage />) },
      { path: "tables", element: loading(<TablesPage />) },
      { path: "tables/:tableId", element: loading(<TablePage />) },
      { path: "relations", element: loading(<RelationsPage />) },
      { path: "sharing", element: loading(<SharingPage />) },
    ],
  },
  {
    path: "/sources/:sourceId/add",
    element: (
      <UploadGuard permissions={CHANGE_UPLOAD}>
        <AddTablesPage />
      </UploadGuard>
    ),
  },
  {
    path: "/sources/:sourceId/tables/:tableId/reupload",
    element: (
      <UploadGuard permissions={CHANGE_UPLOAD}>
        <ReuploadPage />
      </UploadGuard>
    ),
  },
  {
    // Add data is the person's own: under My Zeteo, beside My sources.
    path: "/my/data/new",
    element: (
      <UploadGuard permissions={[FILE_SOURCES_WRITE]}>
        <AddDataPage />
      </UploadGuard>
    ),
  },
];
