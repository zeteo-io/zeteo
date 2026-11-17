import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Centered, Spinner } from "@kosmeo-ui/react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { Dashboard, DashboardTheme } from "../api/types";
import { faExpand } from "@fortawesome/free-solid-svg-icons";
import { useRunDashboard } from "../api/useRunDashboard";
import { useAutoRefresh } from "../api/useAutoRefresh";
import { ErrorNotice } from "@/components/ErrorNotice";
import type { PanelRun } from "../api/useRunDashboard";
import { useDashboard } from "../api/useDashboard";
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

const HIDE_AFTER_MS = 3000;

/**
 * A "Full screen" button in the top-right corner: shown on load and while the
 * mouse moves, hidden after 3 seconds without movement (an unattended screen
 * stays clean) and while the document is full screen. Not rendered where the
 * browser has no Fullscreen API. A refused request is ignored.
 */
export const FullScreenButton = () => {
  const [visible, setVisible] = useState(true);
  const [fullscreen, setFullscreen] = useState(
    () => document.fullscreenElement != null
  );

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const show = () => {
      setVisible(true);
      clearTimeout(timer);
      timer = setTimeout(() => setVisible(false), HIDE_AFTER_MS);
    };
    const onChange = () => setFullscreen(document.fullscreenElement != null);
    show();
    document.addEventListener("mousemove", show);
    document.addEventListener("fullscreenchange", onChange);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousemove", show);
      document.removeEventListener("fullscreenchange", onChange);
    };
  }, []);

  if (!document.fullscreenEnabled || fullscreen) return null;
  return (
    <div className="z-display-fullscreen" data-visible={visible}>
      <Button
        size="sm"
        variant="secondary"
        fullWidth={false}
        onClick={() => {
          void Promise.resolve(
            document.documentElement.requestFullscreen()
          ).catch(() => undefined);
        }}
      >
        <FontAwesomeIcon icon={faExpand} /> Full screen
      </Button>
    </div>
  );
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

/**
 * The panels whose last line disagrees with the dashboard as loaded: a state
 * other than the panel's, or a panel the dashboard does not have yet. Empty
 * when they agree; a key that changes when what disagrees does.
 */
export const disagreement = (
  dashboard: Dashboard | undefined,
  runs: Record<string, PanelRun>
): string => {
  if (!dashboard) return "";
  const byId = new Map(dashboard.panels.map((p) => [p.id, p]));
  return Object.entries(runs)
    .filter(([id, run]) => {
      if (run.state === undefined || run.loading) return false;
      const panel = byId.get(id);
      return (
        !panel ||
        panel.state !== run.state ||
        (run.state === "ok" && panel.chart === undefined)
      );
    })
    .map(([id, run]) => `${id}:${run.state}`)
    .sort()
    .join(",");
};

/** `/dashboards/:dashboardId/display`: the dashboard alone, refreshing itself. */
export const DisplayPage = () => {
  const id = useUuidParam("dashboardId");
  return id ? <Display key={id} dashboardId={id} /> : <NotFound />;
};

const Display = ({ dashboardId }: { dashboardId: string }) => {
  const {
    data: dashboard,
    error,
    failureReason,
    isLoading,
    refetch,
  } = useDashboard(dashboardId, { retryUntilLoaded: true });
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

  // Once a 401 is seen the screen stays signed out until the person signs in.
  const [signedOut, setSignedOut] = useState(false);
  const unauthorized = error?.status === 401 || runner.error?.status === 401;
  useEffect(() => {
    if (unauthorized) setSignedOut(true);
  }, [unauthorized]);

  // A tick never cuts a run still going: a slow run finishes first. Held in
  // a ref from the moment the run starts, not from its next render.
  const running = useRef<Promise<void> | null>(null);
  const runUnlessRunning = useCallback(() => {
    if (running.current) return;
    running.current = run().finally(() => {
      running.current = null;
    });
  }, [run]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  // The dashboard's own range: a display has no picker.
  useEffect(() => {
    if (loaded) runUnlessRunning();
  }, [loaded, runUnlessRunning]);

  // Each tick reloads the dashboard too, so the owner's changes appear.
  useAutoRefresh({
    seconds: refreshSeconds,
    enabled: loaded && !signedOut,
    onTick: () => {
      if (running.current) return;
      void refetch();
      runUnlessRunning();
    },
  });

  // A line that disagrees with the dashboard (a panel fixed or added since it
  // loaded) reloads it, once for each new disagreement.
  const differs = disagreement(dashboard, runner.panels);
  const reloadedFor = useRef("");
  useEffect(() => {
    if (differs === reloadedFor.current) return;
    reloadedFor.current = differs;
    if (differs !== "" && !signedOut) void refetch();
  }, [differs, signedOut, refetch]);

  if (signedOut || unauthorized) {
    return <DisplaySignedOut />;
  }
  if (!dashboard) {
    // While a failed load is retried its reason stays up; the screen recovers on its own.
    const shown = error ?? failureReason;
    if (isLoading && !shown) {
      return (
        <Centered>
          <Spinner size="lg" />
        </Centered>
      );
    }
    return (
      <div className="z-display">
        <ErrorNotice error={shown} />
      </div>
    );
  }

  return (
    <div className="z-display">
      <FullScreenButton />
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
