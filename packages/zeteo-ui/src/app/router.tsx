import { RequirePermission } from "@/components/RequirePermission";
import { EmptyState, Spinner } from "@kosmeo-ui/react";
import { PageHeader } from "@/components/PageHeader";
import { RootLayout } from "./layouts/RootLayout";
import { Suspense, lazy, useState } from "react";
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
  return section ? <Navigate to={section.path} replace /> : null;
};

const NotFound = () => (
  <>
    <PageHeader title="Page not found" />
    <EmptyState layout="block">There is nothing at this address.</EmptyState>
  </>
);

export const routes = [
  {
    path: "/",
    element: <RootLayout />,
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
