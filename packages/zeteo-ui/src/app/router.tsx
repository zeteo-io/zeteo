import { Suspense, lazy, useState, type ComponentType } from "react";
import { RequirePermission } from "@/components/RequirePermission";
import { NoAccessSection } from "@/components/NoAccessSection";
import { sourceRoutes } from "@/features/sources/routes";
import { EmptyState, Spinner } from "@kosmeo-ui/react";
import { RouteError } from "@/components/RouteError";
import { PageHeader } from "@/components/PageHeader";
import { RootLayout } from "./layouts/RootLayout";
import { SECTIONS } from "./sections";
import { useAuth } from "@/lib/auth";
import {
  createBrowserRouter,
  Navigate,
  RouterProvider,
} from "react-router-dom";

const pages = {
  "/sources": lazy(() =>
    import("@/features/sources").then((m) => ({ default: m.SourcesPage }))
  ),
  "/grants": lazy(() =>
    import("@/features/grants").then((m) => ({ default: m.GrantsPage }))
  ),
  "/limits": lazy(() =>
    import("@/features/limits").then((m) => ({ default: m.LimitsPage }))
  ),
  "/runs": lazy(() =>
    import("@/features/runs").then((m) => ({ default: m.RunsPage }))
  ),
} as const;

/** `/` goes to the first section the person can read. */
const DefaultSection = () => {
  const { can } = useAuth();
  const section = SECTIONS.find((s) => can(s.permission));
  // Holding none of the sections' permissions: say what is missing.
  return section ? (
    <Navigate to={section.path} replace />
  ) : (
    <NoAccessSection permission={SECTIONS[0].permission} />
  );
};

const NotFound = () => (
  <>
    <PageHeader title="Page not found" />
    <EmptyState layout="block">There is nothing at this address.</EmptyState>
  </>
);

const tablesPage = lazy(() =>
  import("@/features/tables").then((m) => ({ default: m.TablesPage }))
);
const tablePage = lazy(() =>
  import("@/features/tables").then((m) => ({ default: m.TablePage }))
);
const relationsPage = lazy(() =>
  import("@/features/relations").then((m) => ({ default: m.RelationsPage }))
);

const inSuspense = (Page: ComponentType) => (
  <Suspense fallback={<Spinner size="lg" />}>
    <Page />
  </Suspense>
);

/** A source's tables and relations pages, in place of the source routes' placeholders. */
const catalogueRoutes = [
  { path: "tables", element: inSuspense(tablesPage) },
  { path: "tables/:tableId", element: inSuspense(tablePage) },
  { path: "relations", element: inSuspense(relationsPage) },
];

const sourceRoutesWithCatalogue = sourceRoutes.map((route) =>
  route.children
    ? {
        ...route,
        children: [
          ...route.children.filter(
            (child) => child.path !== "tables" && child.path !== "relations"
          ),
          ...catalogueRoutes,
        ],
      }
    : route
);

export const routes = [
  {
    path: "/",
    element: <RootLayout />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <DefaultSection /> },
      ...SECTIONS.map((section) => {
        const Page = pages[section.path as keyof typeof pages];
        return {
          path: section.path,
          element: (
            <RequirePermission permission={section.permission}>
              <Suspense fallback={<Spinner size="lg" />}>
                <Page />
              </Suspense>
            </RequirePermission>
          ),
        };
      }),
      ...sourceRoutesWithCatalogue,
      { path: "*", element: <NotFound /> },
    ],
  },
];

/**
 * The router is made when this first renders, which is after sign-in: the
 * auth provider rewrites /callback?code=… before it renders its children, and
 * a router made at import time would start on that stale address.
 */
export const AppRouter = () => {
  const [router] = useState(() =>
    createBrowserRouter(routes, { basename: "/" })
  );
  return <RouterProvider router={router} />;
};
