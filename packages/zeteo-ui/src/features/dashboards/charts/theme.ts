import { useEffect, useState } from "react";

/** The colours a chart is drawn with. */
export interface ChartTheme {
  /** Ten categorical colours, in the order series take them. */
  palette: string[];
  text: string;
  textSecondary: string;
  border: string;
  background: string;
}

// Series colours, in order. Colours 1-6 come from kosmeo's variables, read at
// theme time so dark mode gets kosmeo's dark values: primary, success,
// warning, danger, link, secondary. Colours 7-10 (kosmeo defines no more
// accents) are fixed hues, one set per theme. The fallbacks are for where the
// variable is missing (a test).
const KOSMEO_COLOURS: [string, string, string][] = [
  ["--k-primary-color-background", "#3d52db", "#4a5fb5"],
  ["--k-success-color", "#198754", "#1f7a4e"],
  ["--k-warning-color", "#ffc107", "#d99e00"],
  ["--k-danger-color", "#dc3545", "#c94250"],
  ["--k-text-color-link", "#0062cc", "#6e9fff"],
  ["--k-secondary-color", "#6b6b6b", "#646a75"],
];
const LIGHT_EXTRA = ["#9c36b5", "#0c8599", "#e03177", "#74a30a"];
const DARK_EXTRA = ["#c77ddb", "#3bc0d4", "#f06595", "#a9d34a"];

/** Whether the page is dark: an explicit data-theme wins, else the system preference. */
function isDark(): boolean {
  const explicit = document.documentElement.getAttribute("data-theme");
  if (explicit) return explicit === "dark";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

/** Reads kosmeo's CSS variables for the current theme. */
export function chartTheme(): ChartTheme {
  const style = getComputedStyle(document.documentElement);
  const dark = isDark();
  const read = (name: string, fallback: string) =>
    style.getPropertyValue(name).trim() || fallback;
  return {
    palette: [
      ...KOSMEO_COLOURS.map(([name, light, dk]) =>
        read(name, dark ? dk : light)
      ),
      ...(dark ? DARK_EXTRA : LIGHT_EXTRA),
    ],
    text: read("--k-text-color", dark ? "#e8e8e8" : "#1a1a1a"),
    textSecondary: read(
      "--k-text-color-secondary",
      dark ? "#a0a0a0" : "#5c5c5c"
    ),
    border: read("--k-border-color", dark ? "#3a3a3a" : "#dddddd"),
    background: read("--k-background-color", dark ? "#1a1a1a" : "#ffffff"),
  };
}

/** The chart theme, re-read when the page switches between light and dark. */
export function useChartTheme(): ChartTheme {
  const [theme, setTheme] = useState(chartTheme);
  useEffect(() => {
    const update = () => setTheme(chartTheme());
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    media?.addEventListener?.("change", update);
    return () => {
      observer.disconnect();
      media?.removeEventListener?.("change", update);
    };
  }, []);
  return theme;
}
