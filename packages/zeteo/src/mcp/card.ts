import type { TereoMcp } from "@tereo-io/mcp";
import { logger } from "../utils/logger.js";
import { readFileSync } from "fs";

/** The preview card of a panel or saved panel (MCP Apps). */
export const PANEL_CARD_URI = "ui://zeteo/panel-card.html";
/** The preview card of a dashboard (MCP Apps). */
export const DASHBOARD_CARD_URI = "ui://zeteo/dashboard-card.html";

const CARD_MIME_TYPE = "text/html;profile=mcp-app";

/** What a tool linked to a card adds to its description, so the model knows the card is shown. */
export const CARD_NOTES = {
  panel:
    "In clients that show MCP Apps, the person sees the panel drawn as a card under this call: do not draw it again or say it cannot be shown.",
  dashboard:
    "In clients that show MCP Apps, the person sees the dashboard drawn as a card under this call: do not draw it again or say it cannot be shown.",
} as const;

/** `description` with the card's note when the cards are served, as is otherwise. */
export const withCardNote = (
  cards: boolean,
  card: keyof typeof CARD_NOTES,
  description: string
): string => (cards ? `${description} ${CARD_NOTES[card]}` : description);

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
 * serves, each naming its mode in `<head>`. Null, with a warning, when the
 * file does not exist, or when a page would pass `maxBytes` (the server's
 * `maxResultBytes`, past which every read of it would fail). Any other read
 * failure, or a file with no `<head>`, throws.
 */
export const loadCard = (path: string, maxBytes: number): Cards | null => {
  let html: string;
  try {
    html = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      logger.warn(
        { path },
        "MCP preview cards are off: MCP_CARD_PATH names no file"
      );
      return null;
    }
    throw err;
  }
  if (!HEAD.test(html)) {
    throw new Error(`The MCP card at ${path} has no <head>`);
  }
  const cards = {
    panel: withMode(html, "panel"),
    dashboard: withMode(html, "dashboard"),
  };
  const bytes = Math.max(
    Buffer.byteLength(cards.panel, "utf8"),
    Buffer.byteLength(cards.dashboard, "utf8")
  );
  if (bytes > maxBytes) {
    logger.warn(
      { path, bytes, max_bytes: maxBytes },
      "MCP preview cards are off: the card at MCP_CARD_PATH is larger than a resource may be"
    );
    return null;
  }
  return cards;
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
