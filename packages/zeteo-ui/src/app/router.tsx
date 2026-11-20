import { RequirePermission } from "@/components/RequirePermission";
import { Suspense, createElement, lazy, useState } from "react";
import { NoAccessSection } from "@/components/NoAccessSection";
import { sourceRoutes } from "@/features/sources/routes";
import { DisplaySignedOut } from "@/features/dashboards";
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

const pages = {
  "/sources": lazy(() =>
    import("@/features/sources").then((m) => ({ default: m.SourcesPage }))
  ),
  "/connections": lazy(() =>
    import("@/features/connections").then((m) => ({
      default: m.ConnectionsPage,
    }))
  ),
  "/grants": lazy(() =>
    import("@/features/grants").then((m) => ({ default: m.GrantsPage }))
  ),
  "/limits": lazy(() =>
    import("@/features/limits").then((m) => ({ default: m.LimitsPage }))
  ),
  "/identities": lazy(() =>
    import("@/features/identity").then((m) => ({
      default: m.IdentityKeysPage,
    }))
  ),
  "/calendar": lazy(() =>
    import("@/features/calendar").then((m) => ({ default: m.CalendarPage }))
  ),
  "/runs": lazy(() =>
    import("@/features/runs").then((m) => ({ default: m.RunsPage }))
  ),
  "/saved-queries": lazy(() =>
    import("@/features/saved-queries").then((m) => ({
      default: m.SavedQueriesPage,
    }))
  ),
  "/admin/dashboards": lazy(() =>
    import("@/features/dashboards").then((m) => ({
      default: m.AdminDashboardsPage,
    }))
  ),
  "/admin/saved-panels": lazy(() =>
    import("@/features/dashboards").then((m) => ({
      default: m.AdminSavedPanelsPage,
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

/** `/` goes to the first section the person can read: My Zeteo, else an admin section. */
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

const identityValuesPage = lazy(() =>
  import("@/features/identity").then((m) => ({
    default: m.IdentityValuesPage,
  }))
);

/** One identity key's values, for those who read grants. */
const identityRoutes = [
  {
    path: "identities/:keyId",
    element: (
      <RequirePermission permission="zeteo.grants.read">
        <Suspense fallback={<Spinner size="lg" />}>
          {createElement(identityValuesPage)}
        </Suspense>
      </RequirePermission>
    ),
  },
];

const displayPage = lazy(() =>
  import("@/features/dashboards").then((m) => ({ default: m.DisplayPage }))
);

/** Display mode: outside the layout (no top bar), behind sign-in, and never redirecting on a lost session. */
const displayRoute = {
  path: "/dashboards/:dashboardId/display",
  element: (
    <AuthGate signedOut={<DisplaySignedOut />}>
      <RequirePermission permission="zeteo.data.read">
        <Suspense fallback={<Spinner size="lg" />}>
          {createElement(displayPage)}
        </Suspense>
      </RequirePermission>
    </AuthGate>
  ),
  errorElement: <RouteError />,
};

export const routes = [
  // Public: the provider lets these render without a session.
  { path: "/callback", element: <Callback />, errorElement: <RouteError /> },
  {
    path: "/signed-out",
    element: <SignedOut />,
    errorElement: <RouteError />,
  },
  displayRoute,
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
      ...savedQueryRoutes,
      ...dashboardRoutes,
      ...identityRoutes,
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
