import type { Env } from "../env.js";

/**
 * The content security policy of every response. The UI is same-origin
 * scripts and fonts; styles may be inline (component libraries set them);
 * the browser may call tereo, and only when the UI is configured.
 */
export const cspDirectives = (
  env: Pick<Env, "UI_CLIENT_ID" | "UI_TEREO_URL" | "PUBLIC_URL">
): Record<string, string[]> => ({
  "default-src": ["'self'"],
  "script-src": ["'self'"],
  "connect-src": [
    "'self'",
    ...(env.UI_CLIENT_ID && env.UI_TEREO_URL
      ? [new URL(env.UI_TEREO_URL).origin]
      : []),
  ],
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
