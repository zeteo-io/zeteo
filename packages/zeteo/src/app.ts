import { createRequestIdMiddleware } from "./utils/requestId.js";
import { errorHandler, NotFoundError } from "./utils/errors.js";
import routes from "./routes/index.js";
import express from "express";
import helmet from "helmet";
import env from "./env.js";
import cors from "cors";

const app = express();

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
app.set("trust proxy", trustProxy);

app.use(createRequestIdMiddleware());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: env.CORS_ALLOWED_ORIGINS }));
// JSON bodies are parsed per area, each with its own limit.
app.use(routes);

app.use(() => {
  throw new NotFoundError("Not found");
});

app.use(errorHandler);

export default app;
