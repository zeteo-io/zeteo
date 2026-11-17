import { Alert, Button, Centered, Spinner } from "@kosmeo-ui/react";
import { useRunDashboard } from "../api/useRunDashboard";
import { ErrorNotice } from "@/components/ErrorNotice";
import { useEffect, useMemo, useState } from "react";
import { useDashboard } from "../api/useDashboard";
import type { DashboardTheme } from "../api/types";
import { useUuidParam } from "@/lib/useUuidParam";
import { NotFound } from "@/components/NotFound";
import { DashboardGrid } from "./DashboardGrid";
import { useAuth } from "@tereo-io/react";
import { PanelFrame } from "./PanelFrame";
import "./styles.css";

const DARK = "(prefers-color-scheme: dark)";

/**
 * Puts the dashboard's theme on the page through `data-theme`, which the
 * charts watch; `auto` follows the system preference. Restores what was there.
 */
const useDisplayTheme = (theme: DashboardTheme | undefined) => {
  useEffect(() => {
    if (!theme) return;
    const root = document.documentElement;
    const before = root.getAttribute("data-theme");
    const media = window.matchMedia?.(DARK);
    const apply = () =>
      root.setAttribute(
        "data-theme",
        theme === "auto" ? (media?.matches ? "dark" : "light") : theme
      );
    apply();
    if (theme === "auto") media?.addEventListener?.("change", apply);
    return () => {
      media?.removeEventListener?.("change", apply);
      if (before === null) root.removeAttribute("data-theme");
      else root.setAttribute("data-theme", before);
    };
  }, [theme]);
};

/** A wall screen must not bounce into a sign-in loop: it says so and waits to be signed in again. */
export const DisplaySignedOut = () => {
  const { signIn } = useAuth();
  return (
    <Centered>
      <div className="z-display-signedout">
        <Alert variant="warning">
          <p>Signed out — sign in again on this screen</p>
        </Alert>
        <Button
          fullWidth={false}
          onClick={() => void signIn({ returnTo: window.location.pathname })}
        >
          Sign in
        </Button>
      </div>
    </Centered>
  );
};

/** `/dashboards/:dashboardId/display`: the dashboard alone, refreshing itself. */
export const DisplayPage = () => {
  const id = useUuidParam("dashboardId");
  return id ? <Display key={id} dashboardId={id} /> : <NotFound />;
};

const Display = ({ dashboardId }: { dashboardId: string }) => {
  const { data: dashboard, error, isLoading } = useDashboard(dashboardId);
  const panelIds = useMemo(
    () => dashboard?.panels.map((p) => p.id) ?? [],
    [dashboard]
  );
  const runner = useRunDashboard(dashboardId, panelIds);
  const [now, setNow] = useState(() => Date.now());
  const { run } = runner;
  const loaded = dashboard !== undefined;
  const refreshSeconds = dashboard?.refresh_seconds ?? null;
  useDisplayTheme(dashboard?.theme);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  // The dashboard's own range: a display has no picker.
  useEffect(() => {
    if (loaded) void run();
  }, [loaded, run]);

  useEffect(() => {
    if (!loaded || refreshSeconds === null) return;
    const timer = setInterval(() => void run(), refreshSeconds * 1000);
    return () => clearInterval(timer);
  }, [loaded, refreshSeconds, run]);

  if (error?.status === 401 || runner.error?.status === 401) {
    return <DisplaySignedOut />;
  }
  if (isLoading) {
    return (
      <Centered>
        <Spinner size="lg" />
      </Centered>
    );
  }
  if (!dashboard) {
    return (
      <div className="z-display">
        <ErrorNotice error={error} />
      </div>
    );
  }

  return (
    <div className="z-display">
      <h1 className="z-display-title">{dashboard.name}</h1>
      {dashboard.panels.length === 0 ? (
        <p className="z-note">This dashboard has no panels yet.</p>
      ) : (
        <DashboardGrid
          panels={dashboard.panels}
          editing={false}
          renderPanel={(panel) => (
            <PanelFrame panel={panel} run={runner.panels[panel.id]} now={now} />
          )}
        />
      )}
    </div>
  );
};
