/** The colours a chart is drawn with. */
export interface ChartTheme {
  /** Ten categorical colours, in the order series take them. */
  palette: string[];
  text: string;
  textSecondary: string;
  border: string;
  background: string;
}

// Fixed categorical palettes (the same ten hues, tuned for each background).
const LIGHT_PALETTE = [
  "#2f6fed",
  "#e8590c",
  "#2b9a66",
  "#9c36b5",
  "#d6a100",
  "#0c8599",
  "#e03177",
  "#5c7cfa",
  "#74a30a",
  "#868e96",
];
const DARK_PALETTE = [
  "#6c9cff",
  "#ff8a4c",
  "#4cc38a",
  "#c77ddb",
  "#f0c040",
  "#3bc0d4",
  "#f06595",
  "#91a7ff",
  "#a9d34a",
  "#adb5bd",
];

/**
 * Reads kosmeo's CSS variables (falling back to fixed values where one is
 * missing, as in a test) and picks the palette for the current theme.
 */
export function chartTheme(): ChartTheme {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const read = (name: string, fallback: string) =>
    style.getPropertyValue(name).trim() || fallback;
  const dark = root.getAttribute("data-theme") === "dark";
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
