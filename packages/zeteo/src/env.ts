import "./preload.js";
import { z } from "zod";

// The one env schema for the whole service.
//
// Values are read from the real environment (and `.env` via preload). Nothing
// rewrites URLs per runtime context, so local and test runs set DATABASE_URL
// and REDIS_URL explicitly.

const DEV_PUBLIC_URL = "http://localhost:4201";

const corsOrigins = z.string().transform((val) =>
  val === "*"
    ? ("*" as const)
    : val
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
);

/**
 * The environment as the schema reads it. An empty value is unset, so its
 * default applies: `FOO=` in a .env, or compose's `FOO: ${FOO}` with FOO
 * unset, must not coerce to 0 or "".
 */
const prepareEnv = (input: unknown): unknown => {
  if (typeof input !== "object" || input === null) return input;
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== "")
  );
};

/** Needed to reach tereo; test mode runs without it. */
const TEREO_CONNECTION = [
  "TEREO_URL",
  "TEREO_CLIENT_ID",
  "TEREO_CLIENT_SECRET",
  "REQUEST_HANDLER_KEY",
] as const;

/** An integer setting within [min, max]: a duration, a count or a port. */
const int = (min: number, max: number, fallback: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const EnvFields = z
  .object({
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    PORT: int(1, 65535, 4201),
    // Externally reachable base URL of this service. Required in production.
    PUBLIC_URL: z.string().url().optional(),
    DATABASE_URL: z.string(),
    REDIS_URL: z.string(),
    // Postgres connections per process.
    DB_POOL_MAX: int(1, 1000, 10),
    DB_POOL_MIN: int(0, 1000, 0),
    // How long a query waits for a free connection before it fails.
    DB_POOL_CONNECTION_TIMEOUT_MS: int(100, 600_000, 5000),
    // How long a transaction waits to start (a connection included), and how
    // long it may run. Either running out answers 503 temporarily_unavailable.
    DB_TRANSACTION_MAX_WAIT_MS: int(100, 600_000, 5000),
    DB_TRANSACTION_TIMEOUT_MS: int(100, 600_000, 10_000),
    // How long a statement in a mutation waits for a row or table lock before
    // the request answers 503. Below DB_TRANSACTION_TIMEOUT_MS, so a lock wait
    // ends as a lock timeout rather than an expired transaction.
    DB_LOCK_TIMEOUT_MS: int(100, 600_000, 5000),
    // The tereo core this service is an app service of, and the credentials
    // its deploy was given.
    TEREO_URL: z.string().url().optional(),
    TEREO_CLIENT_ID: z.string().optional(),
    TEREO_CLIENT_SECRET: z.string().optional(),
    // Encrypts what the SDK's request handler stores; 32 or more characters.
    REQUEST_HANDLER_KEY: z.string().min(32).optional(),
    // Accepts the SDK's test tokens instead of tereo's. Refused in production.
    TEREO_TEST_MODE: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    // Express `trust proxy`: a hop count, a CIDR list, a named range, or
    // "true" / "false". "true" is refused in production, where it lets
    // clients choose their IP.
    TRUST_PROXY: z.string().default("false"),
    // Defaults to PUBLIC_URL's origin.
    CORS_ALLOWED_ORIGINS: corsOrigins.optional(),
    // On SIGTERM, how long in-flight requests get before they are cut off.
    SHUTDOWN_TIMEOUT_SECONDS: int(1, 3600, 25),
  })
  .superRefine((val, ctx) => {
    if (val.DB_POOL_MIN > val.DB_POOL_MAX) {
      ctx.addIssue({
        code: "custom",
        path: ["DB_POOL_MIN"],
        message: "DB_POOL_MIN must not exceed DB_POOL_MAX",
      });
    }
    if (val.DB_LOCK_TIMEOUT_MS >= val.DB_TRANSACTION_TIMEOUT_MS) {
      ctx.addIssue({
        code: "custom",
        path: ["DB_LOCK_TIMEOUT_MS"],
        message: "DB_LOCK_TIMEOUT_MS must be below DB_TRANSACTION_TIMEOUT_MS",
      });
    }
    if (val.NODE_ENV === "production" && val.TEREO_TEST_MODE) {
      ctx.addIssue({
        code: "custom",
        path: ["TEREO_TEST_MODE"],
        message: "TEREO_TEST_MODE is refused in production",
      });
    }
    if (!val.TEREO_TEST_MODE) {
      for (const name of TEREO_CONNECTION) {
        if (!val[name]) {
          ctx.addIssue({
            code: "custom",
            path: [name],
            message: `${name} is required unless TEREO_TEST_MODE is set`,
          });
        }
      }
    }
    if (val.NODE_ENV === "production") {
      if (!val.PUBLIC_URL) {
        ctx.addIssue({
          code: "custom",
          path: ["PUBLIC_URL"],
          message: "PUBLIC_URL is required in production",
        });
      }
      if (val.TRUST_PROXY === "true") {
        ctx.addIssue({
          code: "custom",
          path: ["TRUST_PROXY"],
          message:
            "TRUST_PROXY cannot be 'true' in production (it lets clients choose their IP): use a hop count, a CIDR list, 'loopback' or 'false'",
        });
      }
    }
  })
  .transform((raw) => {
    const publicUrl = (raw.PUBLIC_URL ?? DEV_PUBLIC_URL).replace(/\/+$/, "");
    return {
      ...raw,
      PUBLIC_URL: publicUrl,
      CORS_ALLOWED_ORIGINS: raw.CORS_ALLOWED_ORIGINS ?? [
        new URL(publicUrl).origin,
      ],
      SERVICE_NAME: "zeteo" as const,
    };
  });

export const EnvSchema = z.preprocess(prepareEnv, EnvFields);

export type Env = z.infer<typeof EnvFields>;

export const parseEnv = (input: unknown): Env => EnvSchema.parse(input) as Env;

export default parseEnv(process.env);
