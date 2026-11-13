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

export const clientNames = (): ClientNames => {
  const service = buildClientName(ZETEO_TEMPLATE, {
    instanceId: "sdk",
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

// A 429 is returned to the caller at once: retrying would freeze the client
// for every other request.
export const classifyZeteoError: ErrorClassifier = (error) =>
  error.response?.status === 429 ? { action: "fail" } : undefined;

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
