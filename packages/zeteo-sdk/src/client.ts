import { redisBackend } from "@dianemo/backend-redis";
import RequestHandler from "@dianemo/core";
import type { Transport } from "./send.js";
import { zeteoPlugin } from "./plugin.js";
import type { Redis } from "ioredis";
import {
  clientNames,
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

export interface ZeteoClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** @internal */
  transport: Transport;
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
    instanceId: "sdk",
    organizationId: null,
    baseUrl: options.url.replace(/\/+$/, ""),
    tereoUrl: options.tereoUrl.replace(/\/+$/, ""),
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

  return {
    async start() {
      await added;
      await handler.start();
      // A hook registered while the handler was mid-start never runs.
      const names = clientNames();
      if (!handler.getMetadata().registeredClients.includes(names.service)) {
        await addClient(handler);
      }
    },
    async stop() {
      if (ownsHandler) await handler.stop();
    },
    transport: {
      handler,
      names: clientNames(),
      getRequestId,
      async purgeServiceToken() {
        // `getClient` is protected in @dianemo/core's types; the client it
        // returns has `purgeCredentials` as a public method.
        const h = handler as unknown as {
          getClient(name: string): { purgeCredentials(): Promise<void> };
        };
        await h.getClient(clientNames().service).purgeCredentials();
      },
    },
  };
}
