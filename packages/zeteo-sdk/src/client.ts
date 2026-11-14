import { principalLimitsCalls } from "./calls/principalLimits.js";
import { principalsCalls } from "./calls/principals.js";
import { redisBackend } from "@dianemo/backend-redis";
import { catalogCalls } from "./calls/catalog.js";
import { sourcesCalls } from "./calls/sources.js";
import { healthCalls } from "./calls/health.js";
import { exportCalls } from "./calls/export.js";
import { grantsCalls } from "./calls/grants.js";
import { queryCalls } from "./calls/query.js";
import type { CallContext } from "./send.js";
import { runsCalls } from "./calls/runs.js";
import RequestHandler from "@dianemo/core";
import type { Transport } from "./send.js";
import { zeteoPlugin } from "./plugin.js";
import { meCalls } from "./calls/me.js";
import type { Redis } from "ioredis";
import {
  clientNames,
  instanceIdFor,
  ZETEO_TEMPLATE,
  type ZeteoCredentials,
} from "./template.js";

export type ZeteoClientOptions = {
  /** Zeteo's base URL. */
  url: string;
  /** Tereo's base URL, where the client credentials are exchanged. */
  tereoUrl: string;
  clientId: string;
  clientSecret: string;
  getRequestId?: () => string | undefined;
} & (
  | { handler: RequestHandler }
  | { redis: Redis; requestHandlerKey: string; production?: boolean }
);

type OwnHandlerOptions = Extract<ZeteoClientOptions, { redis: Redis }>;

const buildCalls = (ctx: CallContext) => ({
  health: healthCalls(ctx),
  catalog: catalogCalls(ctx),
  query: queryCalls(ctx),
  export: exportCalls(ctx),
  runs: runsCalls(ctx),
  me: meCalls(ctx),
  principals: principalsCalls(ctx),
  sources: sourcesCalls(ctx),
  grants: grantsCalls(ctx),
  principalLimits: principalLimitsCalls(ctx),
});

export type ZeteoCalls = ReturnType<typeof buildCalls>;

export interface ZeteoClient extends ZeteoCalls {
  /** The same calls, made with a person's bearer token instead of the service's own credentials. */
  withToken(token: string): ZeteoCalls;
  start(): Promise<void>;
  stop(): Promise<void>;
}

const transports = new WeakMap<ZeteoClient, Transport>();

/** @internal For tests, which need the handler and client names. */
export function transportOf(client: ZeteoClient): Transport {
  const transport = transports.get(client);
  if (!transport) throw new Error("not a client from createZeteoClient");
  return transport;
}

const fail = (message: string): never => {
  throw new Error(`@zeteo-io/sdk: ${message}`);
};

export function createZeteoClient(options: ZeteoClientOptions): ZeteoClient {
  const hasHandler = "handler" in options && options.handler !== undefined;
  const hasRedis = "redis" in options && options.redis !== undefined;
  const hasKey =
    "requestHandlerKey" in options && options.requestHandlerKey !== undefined;
  if (hasHandler && (hasRedis || hasKey)) {
    fail("pass either handler, or redis and requestHandlerKey, not both");
  }
  if (!hasHandler && !(hasRedis && hasKey)) {
    fail("pass handler, or redis and requestHandlerKey");
  }

  const ownsHandler = !hasHandler;
  const handler: RequestHandler =
    "handler" in options && options.handler
      ? options.handler
      : new RequestHandler({
          key: (options as OwnHandlerOptions).requestHandlerKey,
          backend: redisBackend((options as OwnHandlerOptions).redis),
          priority: (options as OwnHandlerOptions).production ? 2 : 1,
          // Tokens and rate-limit state live in Redis under client names that
          // are the same for every service; the client id keeps two services
          // on one Redis apart while replicas of one still share.
          keyPrefix: `@zeteo-io/sdk:${options.clientId}`,
        });

  if (handler.getRegisteredPlugins().includes(zeteoPlugin.name)) {
    fail("a zeteo client is already registered on this handler");
  }
  handler.use(zeteoPlugin);

  const credentials: ZeteoCredentials & {
    instanceId: string;
    organizationId: null;
  } = {
    instanceId: instanceIdFor(options.clientId),
    organizationId: null,
    baseUrl: options.url,
    tereoUrl: options.tereoUrl,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
  };
  const addClient = (h: RequestHandler) =>
    h.addLocalTemplateClient(ZETEO_TEMPLATE, credentials);

  // A hook only runs on a start still to come; a handler that is already
  // started needs the client added now.
  handler.registerStartupHook(addClient);
  const added =
    handler.getMetadata().status === "started" ? addClient(handler) : undefined;
  // Surfaces from start(), which awaits it; no one is awaiting it yet.
  added?.catch(() => undefined);

  const getRequestId = options.getRequestId ?? (() => undefined);

  const names = clientNames(options.clientId);
  const transport: Transport = {
    handler,
    names,
    getRequestId,
    async purgeServiceToken() {
      // `getClient` is protected in @dianemo/core's types; the client it
      // returns has `purgeCredentials` as a public method.
      const h = handler as unknown as {
        getClient(name: string): { purgeCredentials(): Promise<void> };
      };
      await h.getClient(names.service).purgeCredentials();
    },
  };

  const client: ZeteoClient = {
    ...buildCalls({ transport }),
    withToken(token) {
      if (typeof token !== "string" || token === "") {
        fail("withToken needs a token");
      }
      return buildCalls({ transport, token });
    },
    async start() {
      await added;
      await handler.start();
      // A hook registered while the handler was mid-start never runs.
      if (!handler.getMetadata().registeredClients.includes(names.service)) {
        await addClient(handler);
      }
    },
    async stop() {
      if (ownsHandler) await handler.stop();
    },
  };
  transports.set(client, transport);
  return client;
}
