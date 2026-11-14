import express, { type Request, type RequestHandler, Router } from "express";
import { isReserved } from "./reserved.js";
import { uiEnabled } from "./config.js";
import { readFileSync } from "fs";
import env from "../env.js";
import path from "path";

const IMMUTABLE = "public, max-age=31536000, immutable";

/**
 * The admin UI's build: its files, then the app shell (index.html) for page
 * routes. API-looking paths, missing files and non-page requests fall through
 * to the JSON 404. Does nothing unless the UI is served.
 */
export const uiRouter = (): Router => {
  const router = Router();
  if (!uiEnabled()) return router;

  const shell = readFileSync(path.join(env.UI_DIST_PATH, "index.html"));

  router.use(
    express.static(env.UI_DIST_PATH, {
      index: false,
      dotfiles: "ignore",
      redirect: false,
      fallthrough: true,
      setHeaders: (res, filePath) => {
        const inAssets = !path
          .relative(path.join(env.UI_DIST_PATH, "assets"), filePath)
          .startsWith("..");
        res.setHeader("Cache-Control", inAssets ? IMMUTABLE : "no-cache");
      },
    })
  );

  const isPageRequest = (req: Request) =>
    (req.method === "GET" || req.method === "HEAD") &&
    (req.headers.accept ?? "").includes("text/html") &&
    !isReserved(req.path) &&
    !path.posix.basename(req.path).includes(".") &&
    !req.path.split("/").some((segment) => segment.startsWith("."));

  const appShell: RequestHandler = (req, res, next) => {
    if (!isPageRequest(req)) return next();
    res
      .set("Cache-Control", "no-cache")
      .type("text/html; charset=utf-8")
      .send(shell);
  };
  router.use(appShell);

  return router;
};
