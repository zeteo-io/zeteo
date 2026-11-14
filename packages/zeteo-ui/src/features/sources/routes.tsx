import { RequirePermission } from "@/components/RequirePermission";
import { Suspense, lazy, type ReactNode } from "react";
import { EmptyState, Spinner } from "@kosmeo-ui/react";

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

const READ = "zeteo.sources.read";
const WRITE = "zeteo.sources.write";

const guarded = (permission: string, page: ReactNode) => (
  <RequirePermission permission={permission}>
    <Suspense fallback={<Spinner size="lg" />}>{page}</Suspense>
  </RequirePermission>
);

// Replaced by the tables and relations pages.
const Soon = ({ what }: { what: string }) => (
  <EmptyState layout="block">The {what} page is not built yet.</EmptyState>
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
      { path: "tables", element: <Soon what="tables" /> },
      { path: "relations", element: <Soon what="relations" /> },
    ],
  },
];
