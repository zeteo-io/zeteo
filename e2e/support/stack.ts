/** Where the run's services are and the run's generated values, from e2e/run.sh. */

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set: run the e2e suite through e2e/run.sh`);
  }
  return value;
};

export const stack = {
  /** Tereo as the host reaches it; also its issuer. */
  get tereoUrl() {
    return required("E2E_TEREO_URL");
  },
  /** zeteo, whose process does not trust the run's CA. */
  get zeteoUrl() {
    return required("E2E_ZETEO_URL");
  },
  /** A second zeteo replica on the same database, trusting the run's CA through NODE_EXTRA_CA_CERTS. */
  get zeteoCaUrl() {
    return required("E2E_ZETEO_CA_URL");
  },
  get setupToken() {
    return required("E2E_SETUP_TOKEN");
  },
  /** The password every user of the run gets. */
  get userPassword() {
    return required("E2E_USER_PASSWORD");
  },
  get webClientSecret() {
    return required("E2E_WEB_CLIENT_SECRET");
  },
  /** zeteo's own service credentials, as its provisioning document names them. */
  get zeteo() {
    return {
      clientId: "zeteo",
      clientSecret: required("E2E_ZETEO_CLIENT_SECRET"),
    };
  },
  /** The calling app service of e2e/provisioning/e2e-app.json: audience zeteo, role zeteo_admin. */
  get app() {
    return {
      clientId: "e2e-app",
      clientSecret: required("E2E_APP_CLIENT_SECRET"),
    };
  },
  get sourceReaderPassword() {
    return required("E2E_SOURCE_READER_PASSWORD");
  },
  /** The run's CA certificate, PEM, on the host. */
  get caCertPath() {
    return required("E2E_CA_CERT_PATH");
  },
  /** `docker compose` arguments naming the run's project, file and env file. */
  get composeArgs(): string[] {
    return JSON.parse(required("E2E_COMPOSE_ARGS")) as string[];
  },
};

/**
 * The origin zeteo's admin UI is served from, listed in Tereo's
 * CORS_ALLOWED_ORIGINS. Nothing listens there: requests only carry it as
 * their `Origin`, as the page's would.
 */
export const UI_ORIGIN = "http://127.0.0.1:4200";

/** The login clients of e2e/provisioning/e2e-clients.json. */
export const CLIENTS = {
  /** Confidential, audience zeteo: an app whose users call zeteo's /v1. */
  web: {
    clientId: "e2e-web",
    redirectUri: "http://127.0.0.1/e2e-web/callback",
  },
  /** Public, audience zeteo, listed in zeteo's MCP_ALLOWED_CLIENTS. */
  mcp: {
    clientId: "e2e-mcp",
    redirectUri: "http://127.0.0.1/e2e-mcp/callback",
  },
  /** Public, audience zeteo, offline_access: zeteo's admin UI. */
  ui: {
    clientId: "e2e-ui",
    redirectUri: "http://127.0.0.1/e2e-ui/callback",
  },
  /** Public, no zeteo in its audience. */
  other: {
    clientId: "e2e-other",
    redirectUri: "http://127.0.0.1/e2e-other/callback",
  },
  /** Tereo's own admin UI client; its tokens reach Tereo's admin API. */
  tereoUi: {
    clientId: "tereo-ui",
    get redirectUri() {
      return `${stack.tereoUrl}/callback`;
    },
  },
} as const;

export type LoginClient = (typeof CLIENTS)[keyof typeof CLIENTS];
