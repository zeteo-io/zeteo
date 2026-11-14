import { NotFoundError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { Router } from "express";
import { existsSync } from "fs";
import env from "../env.js";
import path from "path";

let enabled: boolean | undefined;

/**
 * Whether the admin UI is served: UI_CLIENT_ID is set and the build exists.
 * Decided once, with one log line.
 */
export const uiEnabled = (): boolean => {
  if (enabled === undefined) {
    const reason = !env.UI_CLIENT_ID
      ? "no UI_CLIENT_ID"
      : !existsSync(path.join(env.UI_DIST_PATH, "index.html"))
        ? "no build"
        : null;
    enabled = reason === null;
    if (reason === null) logger.info("admin UI served");
    else logger.info({ reason }, "admin UI not served");
  }
  return enabled;
};

/**
 * The browser's runtime settings, public by design: where tereo is and which
 * login client the UI signs in with. Answers whenever UI_CLIENT_ID is set,
 * even with no build.
 */
export const uiConfigRouter = Router();

uiConfigRouter.get("/ui-config.json", (_req, res) => {
  if (!env.UI_CLIENT_ID || !env.UI_TEREO_URL) {
    throw new NotFoundError("Not found");
  }
  res.set("Cache-Control", "no-cache").json({
    tereo_url: env.UI_TEREO_URL,
    client_id: env.UI_CLIENT_ID,
  });
});
