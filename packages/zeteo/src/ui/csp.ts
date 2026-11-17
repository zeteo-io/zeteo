import type { Env } from "../env.js";

/** Tereo's origin and its websocket form (live permission updates), only when the UI is configured. */
const tereoOrigins = (
  env: Pick<Env, "UI_CLIENT_ID" | "UI_TEREO_URL">
): string[] => {
  if (!env.UI_CLIENT_ID || !env.UI_TEREO_URL) return [];
  const url = new URL(env.UI_TEREO_URL);
  const socket = `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`;
  return [url.origin, socket];
};

/**
 * The content security policy of every response. The UI is same-origin
 * scripts and fonts; styles may be inline (component libraries set them);
 * the browser may call tereo and open its socket, and only when the UI is configured.
 */
export const cspDirectives = (
  env: Pick<Env, "UI_CLIENT_ID" | "UI_TEREO_URL" | "PUBLIC_URL">
): Record<string, string[]> => ({
  "default-src": ["'self'"],
  "script-src": ["'self'"],
  "connect-src": ["'self'", ...tereoOrigins(env)],
  "style-src": ["'self'", "'unsafe-inline'"],
  "img-src": ["'self'", "data:"],
  "font-src": ["'self'"],
  "object-src": ["'none'"],
  "frame-ancestors": ["'none'"],
  "form-action": ["'self'"],
  "base-uri": ["'self'"],
  ...(env.PUBLIC_URL.startsWith("https:")
    ? { "upgrade-insecure-requests": [] }
    : {}),
});
