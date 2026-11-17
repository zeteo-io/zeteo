import { useEffect, useState } from "react";

/** The colours a chart is drawn with. */
export interface ChartTheme {
  /** Eight categorical colours, in the order series take them; never repeated. */
  palette: string[];
  text: string;
  textSecondary: string;
  border: string;
  background: string;
}

// Series colours, in order: ECharts' own default palettes (its light default,
// and its built-in "dark" theme's for dark mode). A chart never repeats a
// colour: past these nine series it keeps the eight largest and folds the rest
// into a grey "Other" (see toOption.ts), so the palette is never cycled.
export const LIGHT_PALETTE = [
  "#5470c6",
  "#91cc75",
  "#fac858",
  "#ee6666",
  "#73c0de",
  "#3ba272",
  "#fc8452",
  "#9a60b4",
  "#ea7ccc",
];
export const DARK_PALETTE = [
  "#4992ff",
  "#7cffb2",
  "#fddd60",
  "#ff6e76",
  "#58d9f9",
  "#05c091",
  "#ff8a45",
  "#8d48e3",
  "#dd79ff",
];

/** Whether the page is dark: an explicit data-theme wins, else the system preference. */
function isDark(): boolean {
  const explicit = document.documentElement.getAttribute("data-theme");
  if (explicit) return explicit === "dark";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

/** The palette for the current theme, and kosmeo's CSS variables for text, borders and the background. */
export function chartTheme(): ChartTheme {
  const style = getComputedStyle(document.documentElement);
  const dark = isDark();
  const read = (name: string, fallback: string) =>
    style.getPropertyValue(name).trim() || fallback;
  return {
    palette: dark ? DARK_PALETTE : LIGHT_PALETTE,
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
