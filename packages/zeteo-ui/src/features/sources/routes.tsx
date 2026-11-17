import { RequirePermission } from "@/components/RequirePermission";
import { Suspense, lazy, type ReactNode } from "react";
import { Spinner } from "@kosmeo-ui/react";

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
const SourceEditPage = lazy(() =>
  import("./components/SourceFormPages").then((m) => ({
    default: m.SourceEditPage,
  }))
);
const TablesPage = lazy(() =>
  import("@/features/tables").then((m) => ({ default: m.TablesPage }))
);
const TablePage = lazy(() =>
  import("@/features/tables").then((m) => ({ default: m.TablePage }))
);
const RelationsPage = lazy(() =>
  import("@/features/relations").then((m) => ({ default: m.RelationsPage }))
);

const READ = "zeteo.sources.read";
const WRITE = "zeteo.sources.write";

const loading = (page: ReactNode) => (
  <Suspense fallback={<Spinner size="lg" />}>{page}</Suspense>
);

const guarded = (permission: string, page: ReactNode) => (
  <RequirePermission permission={permission}>{loading(page)}</RequirePermission>
);

/** A source's pages, beside the `/sources` list route. */
export const sourceRoutes = [
  { path: "/sources/new", element: guarded(WRITE, <SourceNewPage />) },
  {
    path: "/sources/:sourceId",
    element: guarded(READ, <SourceLayout />),
    children: [
      { index: true, element: <SourceDetailPage /> },
      { path: "edit", element: guarded(WRITE, <SourceEditPage />) },
      { path: "tables", element: loading(<TablesPage />) },
      { path: "tables/:tableId", element: loading(<TablePage />) },
      { path: "relations", element: loading(<RelationsPage />) },
    ],
  },
];
