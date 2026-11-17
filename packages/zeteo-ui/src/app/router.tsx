import { RequirePermission } from "@/components/RequirePermission";
import { NoAccessSection } from "@/components/NoAccessSection";
import { sourceRoutes } from "@/features/sources/routes";
import { Callback, SignedOut } from "@/features/auth";
import { RouteError } from "@/components/RouteError";
import { RootLayout } from "./layouts/RootLayout";
import { NotFound } from "@/components/NotFound";
import { Spinner } from "@kosmeo-ui/react";
import { useAuth } from "@tereo-io/react";
import { AuthGate } from "./AuthGate";
import { SECTIONS } from "./sections";
import {
  createBrowserRouter,
  Navigate,
  RouterProvider,
} from "react-router-dom";
import {
  Suspense,
  createElement,
  lazy,
  useState,
  type ComponentType,
} from "react";

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
  "/saved-queries": lazy(() =>
    import("@/features/saved-queries").then((m) => ({
      default: m.SavedQueriesPage,
    }))
  ),
  "/my": lazy(() =>
    import("@/features/my").then((m) => ({ default: m.MyPage }))
  ),
  "/dashboards": lazy(() =>
    import("@/features/dashboards").then((m) => ({
      default: m.DashboardsPage,
    }))
  ),
} as const;

/** `/` goes to the first section the person can read. */
const DefaultSection = () => {
  const { hasPermission } = useAuth();
  const section = SECTIONS.find((s) => hasPermission(s.permission));
  // Holding none of the sections' permissions: say what is missing.
  return section ? (
    <Navigate to={section.path} replace />
  ) : (
    <NoAccessSection permission={SECTIONS[0].permission} />
  );
};

const savedQueryPage = lazy(() =>
  import("@/features/my").then((m) => ({ default: m.SavedQueryPage }))
);

/** One saved query: anyone who can see it, so the same permission as My Zeteo. */
const savedQueryRoutes = [
  {
    path: "my/saved-queries/:savedQueryId",
    element: (
      <RequirePermission permission="zeteo.data.read">
        <Suspense fallback={<Spinner size="lg" />}>
          {createElement(savedQueryPage)}
        </Suspense>
      </RequirePermission>
    ),
  },
];

const dashboardPage = lazy(() =>
  import("@/features/dashboards").then((m) => ({ default: m.DashboardView }))
);

/** One dashboard, for anyone who can see it; saved panels live in the Dashboards section. */
const dashboardRoutes = [
  {
    path: "dashboards/:dashboardId",
    element: (
      <RequirePermission permission="zeteo.data.read">
        <Suspense fallback={<Spinner size="lg" />}>
          {createElement(dashboardPage)}
        </Suspense>
      </RequirePermission>
    ),
  },
  {
    path: "saved-panels",
    element: <Navigate to="/dashboards?tab=panels" replace />,
  },
];

const grantNewPage = lazy(() =>
  import("@/features/grants").then((m) => ({ default: m.GrantNewPage }))
);
const grantEditPage = lazy(() =>
  import("@/features/grants").then((m) => ({ default: m.GrantEditPage }))
);

const inSuspense = (Page: ComponentType) => (
  <Suspense fallback={<Spinner size="lg" />}>
    <Page />
  </Suspense>
);

const grantWriteRoutes = [
  { path: "grants/new", page: grantNewPage },
  { path: "grants/:grantId/edit", page: grantEditPage },
].map(({ path, page }) => ({
  path,
  element: (
    <RequirePermission permission="zeteo.grants.write">
      {inSuspense(page)}
    </RequirePermission>
  ),
}));

export const routes = [
  // Public: the provider lets these render without a session.
  { path: "/callback", element: <Callback />, errorElement: <RouteError /> },
  {
    path: "/signed-out",
    element: <SignedOut />,
    errorElement: <RouteError />,
  },
  {
    path: "/",
    element: (
      <AuthGate>
        <RootLayout />
      </AuthGate>
    ),
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
      ...sourceRoutes,
      ...grantWriteRoutes,
      ...savedQueryRoutes,
      ...dashboardRoutes,
      { path: "*", element: <NotFound /> },
    ],
  },
];

/** Made at first render, so tests that set the address first start there. */
export const AppRouter = () => {
  const [router] = useState(() =>
    createBrowserRouter(routes, { basename: "/" })
  );
  return <RouterProvider router={router} />;
};
