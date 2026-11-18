import type { TereoMcp } from "@tereo-io/mcp";
import { readFileSync } from "fs";

/** The preview card of a panel or saved panel (MCP Apps). */
export const PANEL_CARD_URI = "ui://zeteo/panel-card.html";
/** The preview card of a dashboard (MCP Apps). */
export const DASHBOARD_CARD_URI = "ui://zeteo/dashboard-card.html";

const CARD_MIME_TYPE = "text/html;profile=mcp-app";

/** The card page, once per mode. */
export interface Cards {
  panel: string;
  dashboard: string;
}

const HEAD = /<head(\s[^>]*)?>/i;

const withMode = (html: string, mode: keyof Cards): string =>
  html.replace(
    HEAD,
    (tag) => `${tag}<meta name="zeteo-card" content="${mode}">`
  );

/**
 * The built card (`zeteo-ui`'s `dist-mcp/card.html`) as the two pages zeteo
 * serves, each naming its mode in `<head>`; null when the file does not
 * exist. Any other read failure, or a file with no `<head>`, throws.
 */
export const loadCard = (path: string): Cards | null => {
  let html: string;
  try {
    html = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw err;
  }
  if (!HEAD.test(html)) {
    throw new Error(`The MCP card at ${path} has no <head>`);
  }
  return {
    panel: withMode(html, "panel"),
    dashboard: withMode(html, "dashboard"),
  };
};

/**
 * Serves both cards. A resource holds nothing a signed-in user may not see:
 * it is the page alone, and draws its rows through the card tools as the
 * viewer.
 */
export const defineCardResources = (mcp: TereoMcp, cards: Cards): void => {
  const meta = { ui: { prefersBorder: true } };
  mcp.resource({
    uri: PANEL_CARD_URI,
    name: "panel-card",
    title: "Panel preview",
    description: "Draws a panel or saved panel as its chart.",
    mimeType: CARD_MIME_TYPE,
    meta,
    read: () => ({ text: cards.panel }),
  });
  mcp.resource({
    uri: DASHBOARD_CARD_URI,
    name: "dashboard-card",
    title: "Dashboard preview",
    description: "Draws a dashboard's panels in its layout.",
    mimeType: CARD_MIME_TYPE,
    meta,
    read: () => ({ text: cards.dashboard }),
  });
};
