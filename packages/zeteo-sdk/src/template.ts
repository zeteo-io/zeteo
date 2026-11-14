import RequestHandler, { buildClientName } from "@dianemo/core";
import type {
  CreateClientData,
  OAuth2Credentials,
  ErrorClassifier,
} from "@dianemo/core/client/types";

export const ZETEO_TEMPLATE = "zeteo";

// `baseUrl` is zeteo's; `tereoUrl` is where the client credentials are exchanged.
export interface ZeteoCredentials extends OAuth2Credentials {
  tereoUrl: string;
}

declare module "@dianemo/core" {
  interface ClientTemplates {
    zeteo: ZeteoCredentials;
  }
}

export interface ClientNames {
  /** Authenticated with the service's own client credentials. */
  service: string;
  /** `service`'s token, without retries after a 5xx or a dropped connection. */
  serviceOnce: string;
  /** Carries no authentication; each request brings the person's token. */
  person: string;
  personOnce: string;
}

const ONCE = "once";

// The service token is cached under the client name, so the name carries the
// client id. A name segment may not hold `:` or whitespace, and must not be
// empty: percent-encoding removes both, keeps distinct ids distinct, and the
// prefix keeps an empty id non-empty.
export const instanceIdFor = (clientId: string): string =>
  `sdk-${encodeURIComponent(clientId)}`;

export const clientNames = (clientId: string): ClientNames => {
  const service = buildClientName(ZETEO_TEMPLATE, {
    instanceId: instanceIdFor(clientId),
    organizationId: null,
  });
  return {
    service,
    serviceOnce: `${service}:${ONCE}`,
    person: `${service}:person`,
    personOnce: `${service}:person:${ONCE}`,
  };
};

// Zeteo rate-limits callers itself; this only smooths bursts.
const RATE_LIMIT: CreateClientData["rateLimit"] = [
  { type: "requestLimit", interval: 1000, tokensToAdd: 1000, maxTokens: 1000 },
];

// A 4xx is the caller's to handle, so the handler logs it at debug. 429 stays
// at error: the caller is over a limit.
const MUTED_STATUSES = Array.from({ length: 100 }, (_, i) => 400 + i).filter(
  (status) => status !== 429
);

// Zeteo's own 502 and 504 codes: one source or one query failed.
const ZETEO_GATEWAY_ERRORS = new Set([
  "query_failed",
  "source_unreachable",
  "query_timeout",
]);

// Axios has parsed a JSON body by now; anything else (text, a stream) is not
// zeteo's.
const errorCode = (data: unknown): unknown =>
  typeof data === "object" && data !== null && !Array.isArray(data)
    ? (data as { error?: unknown }).error
    : undefined;

// A 429, or zeteo's own 502 or 504, is about one caller, one source or one
// query: repeating it re-runs a failed or timed-out query, and the default
// retry would freeze the client for every other caller. A 500, a 503, or a 502
// or 504 from a proxy in front of zeteo is repeated for this request only; a
// `Retry-After` on it is still the shortest wait.
export const classifyZeteoError: ErrorClassifier = (error) => {
  const status = error.response?.status;
  if (status === 429) return { action: "fail" };
  if (status === 502 || status === 504) {
    const code = errorCode(error.response?.data);
    return typeof code === "string" && ZETEO_GATEWAY_ERRORS.has(code)
      ? { action: "fail" }
      : { action: "retry" };
  }
  if (status === 500 || status === 503) return { action: "retry" };
  return undefined;
};

// For writes: after a 5xx or a dropped connection zeteo may already have acted.
export const classifyZeteoWrite: ErrorClassifier = (error) =>
  !error.response ||
  error.response.status >= 500 ||
  error.response.status === 429
    ? { action: "fail" }
    : undefined;

export async function registerZeteoTemplate(
  handler: RequestHandler
): Promise<void> {
  await handler.registerClientTemplate(
    ZETEO_TEMPLATE,
    (creds): CreateClientData[] => {
      const name = buildClientName(ZETEO_TEMPLATE, creds);
      const shared = {
        rateLimit: RATE_LIMIT,
        requestOptions: {
          defaults: { baseURL: creds.baseUrl.replace(/\/+$/, "") },
        },
        httpStatusCodesToMute: MUTED_STATUSES,
        retryOptions: { classifyError: classifyZeteoError },
        subClients: [
          { name: ONCE, retryOptions: { classifyError: classifyZeteoWrite } },
        ],
      };
      return [
        {
          name,
          ...shared,
          authentication: {
            type: "oauth2",
            clientId: creds.clientId,
            clientSecret: creds.clientSecret,
            refreshConfig: {
              url: `${creds.tereoUrl.replace(/\/+$/, "")}/oauth/token`,
              dataLocation: "urlEncodedForm",
              useBasicAuth: true,
              data: {
                grant_type: "client_credentials",
                client_id: creds.clientId,
              },
            },
          },
        },
        { name: `${name}:person`, ...shared },
      ];
    }
  );
}
