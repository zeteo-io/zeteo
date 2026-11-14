import { hostHeaderValidation, originValidation } from "@tereo-io/mcp";
import { createRequestIdMiddleware } from "./utils/requestId.js";
import { errorHandler, NotFoundError } from "./utils/errors.js";
import { uiConfigRouter, uiEnabled } from "./ui/config.js";
import { MCP_PATH, MCP_PATHS } from "./mcp/paths.js";
import express, { type Router } from "express";
import { cspDirectives } from "./ui/csp.js";
import { uiRouter } from "./ui/serve.js";
import routes from "./routes/index.js";
import helmet from "helmet";
import env from "./env.js";
import cors from "cors";

// Express's `req.ip` resolves through `X-Forwarded-For` only when this is
// configured. Numeric strings become hop counts ("1" → one upstream proxy)
// rather than the literal IP "1"; "true"/"false" toggle trust-everything/
// nothing; anything else (e.g. "loopback", a CIDR list) is passed through.
const trustProxy = /^\d+$/.test(env.TRUST_PROXY)
  ? Number(env.TRUST_PROXY)
  : env.TRUST_PROXY === "true"
    ? true
    : env.TRUST_PROXY === "false"
      ? false
      : env.TRUST_PROXY;

/** The app, serving MCP through `mcpRouter` unless it is null (MCP off). */
export const createApp = (mcpRouter: Router | null) => {
  const app = express();
  app.set("trust proxy", trustProxy);

  app.use(createRequestIdMiddleware());
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: cspDirectives(env),
      },
    })
  );
  app.use(cors({ origin: env.CORS_ALLOWED_ORIGINS }));

  if (mcpRouter) {
    // Against DNS rebinding and cross-site calls; /v1 and /health are not
    // checked, as load balancers and probes send other Host values.
    app.use(
      MCP_PATHS,
      hostHeaderValidation([new URL(env.PUBLIC_URL).hostname]),
      originValidation(env.MCP_ALLOWED_ORIGINS)
    );
    // The MCP handler reads a body it finds unparsed with a 4 MiB limit of
    // its own, whatever its content type; parsing every body here holds it
    // to 64 kb, as /v1 is.
    app.use(MCP_PATH, express.json({ limit: "64kb", type: () => true }));
    app.use(mcpRouter);
  }

  uiEnabled();
  app.use(uiConfigRouter);

  // JSON bodies are parsed per area, each with its own limit.
  app.use(routes);
  app.use(uiRouter());

  app.use(() => {
    throw new NotFoundError("Not found");
  });

  app.use(errorHandler);
  return app;
};
