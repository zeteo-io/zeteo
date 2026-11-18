import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CardHost, ToolOutcome } from "./host";
import { DashboardCard } from "./DashboardCard";
import { Spinner } from "@kosmeo-ui/react";
import { PanelCard } from "./PanelCard";
import "./styles.css";

/** Sets the page's theme, which the chart theme and kosmeo's colours follow. */
const applyTheme = (theme: string) =>
  document.documentElement.setAttribute("data-theme", theme);

/**
 * The preview card: waits for the tool's result (a change has then been made,
 * so what is read is the new state), then draws the panel or dashboard card,
 * following the host's theme and telling it the card's height.
 */
export const CardApp = ({ host }: { host: CardHost }) => {
  const [input, setInput] = useState<Record<string, unknown>>({});
  const [outcome, setOutcome] = useState<ToolOutcome | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    applyTheme(host.theme());
    return host.onThemeChange(applyTheme);
  }, [host]);

  useEffect(() => {
    const offInput = host.onToolInput(setInput);
    const offResult = host.onToolResult(setOutcome);
    return () => {
      offInput();
      offResult();
    };
  }, [host]);

  // The height after every render, and whenever the content resizes (a
  // chart drawn, rows arrived, the width changed).
  useLayoutEffect(() => {
    const el = root.current;
    if (el) host.reportSize(Math.ceil(el.getBoundingClientRect().height));
  });
  useEffect(() => {
    const el = root.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() =>
      host.reportSize(Math.ceil(el.getBoundingClientRect().height))
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [host]);

  const Card = host.kind === "dashboard" ? DashboardCard : PanelCard;
  return (
    <div ref={root} className="zc-root">
      {outcome === null ? (
        <div className="zc-loading">
          <Spinner size="sm" />
        </div>
      ) : outcome.ok ? (
        <Card host={host} input={input} result={outcome.value} />
      ) : (
        <p className="zc-message">{outcome.error}</p>
      )}
    </div>
  );
};
