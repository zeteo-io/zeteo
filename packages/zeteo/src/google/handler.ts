import { readGoogleConnection, readGoogleStamp } from "./connectionStore.js";
import google, { type getSpreadsheet } from "@dianemo/plugin-google";
import RequestHandler, { buildClientName } from "@dianemo/core";
import { redisBackend } from "@dianemo/backend-redis";
import { hkdfSync, randomUUID } from "node:crypto";
import { logger } from "../utils/logger.js";
import { redis } from "../utils/redis.js";
import env from "../env.js";
import {
  GoogleKeyRejectedError,
  GoogleNotConfiguredError,
  GoogleUnavailableError,
} from "../utils/errors.js";

const INSTANCE_ID = "main";
/** Reading is all Zeteo does with Google. */
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"];
const BASE_URL = "https://www.googleapis.com";
/** A spreadsheet id that cannot exist: Google answers 403/404 once it has signed the key in. */
const PROBE_SPREADSHEET_ID = "zeteo-key-check";

const build = () => {
  const handler = new RequestHandler({
    key: handlerKey(),
    backend: redisBackend(redis),
    keyPrefix: "zeteo:dianemo",
  });
  return { handler, requests: handler.use(google) };
};

type Built = ReturnType<typeof build>;

let started: Built | undefined;
/** The `updatedAt` of the connection this process last registered. */
let registeredAt: number | undefined;
let startPromise: Promise<Built> | undefined;
/** The handler once its start finished; set only after `start()` resolved. */
let running: Built | undefined;
/** The registration under way, shared by every caller that finds the connection newer. */
let registering: Promise<void> | undefined;

/** The handler's key: 32 bytes derived from the master key, so no second secret is kept. */
const handlerKey = (): string => {
  if (!env.ZETEO_MASTER_KEY) throw new Error("ZETEO_MASTER_KEY is not set");
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(env.ZETEO_MASTER_KEY, "base64url"),
      Buffer.alloc(0),
      "zeteo:dianemo",
      32
    )
  ).toString("base64url");
};

const ensureHandler = () => (started ??= build());

const INSTANCE_PREFIX_PROBE = "validate-";
/** A probe client younger than this may still be in use by another replica's key check. */
const PROBE_SWEEP_AGE_MS = 5 * 60_000;

/** A probe client's instance id: `validate-<epoch ms>-<uuid>`, so a sweep can tell its age. */
const probeInstanceId = () =>
  `${INSTANCE_PREFIX_PROBE}${Date.now()}-${randomUUID()}`;

/**
 * Whether a loaded client is a probe old enough to sweep: one named
 * `validate-<epoch ms>-…` more than `PROBE_SWEEP_AGE_MS` ago, or a
 * `validate-` one with no time in its name.
 */
const isStaleProbe = (instanceId: string | undefined, now: number) => {
  if (!instanceId?.startsWith(INSTANCE_PREFIX_PROBE)) return false;
  const madeAt = /^validate-(\d+)-/.exec(instanceId)?.[1];
  return madeAt === undefined || now - Number(madeAt) > PROBE_SWEEP_AGE_MS;
};

/**
 * Forgets a handler that dianemo stopped on its own. dianemo stops itself on
 * SIGTERM, SIGINT or SIGHUP, before Zeteo has drained its requests; the calls
 * still running then (and a job's sync) would be refused `handler_stopped`.
 * The next use builds and starts a new handler, and registers the connection
 * on it; Zeteo's shutdown stops that one with `stopGoogleHandler`.
 */
const forgetIfStopped = () => {
  if (!running || running !== started) return;
  if (running.handler.getMetadata().status !== "stopped") return;
  logger.warn("The Google handler stopped on its own; starting a new one");
  started = undefined;
  startPromise = undefined;
  running = undefined;
  registeredAt = undefined;
};

/**
 * Starts the handler once (again after dianemo stopped it, `forgetIfStopped`).
 * The start loads every stored client, so a probe client a dead process left
 * behind (`validate-*`, holding a candidate key) is among the loaded ones:
 * dianemo lists no stored templates, only the clients this replica loaded,
 * and those older than `PROBE_SWEEP_AGE_MS` are swept (a younger one may be
 * another replica's check under way).
 */
const ensureStarted = (): Promise<Built> => {
  forgetIfStopped();
  return (startPromise ??= (async () => {
    const built = ensureHandler();
    await built.handler.start();
    if (started === built) running = built;
    const now = Date.now();
    for (const { name } of built.handler.getLoadedClients()) {
      const instanceId = name.split(":")[2];
      if (isStaleProbe(instanceId, now)) {
        await built.handler
          .removeTemplateClient("google", instanceId)
          .catch((err: unknown) =>
            logger.warn(
              { code: codeOf(err), instanceId },
              "Could not remove a leftover Google key-check client"
            )
          );
      }
    }
    return built;
  })().catch((err: unknown) => {
    startPromise = undefined;
    throw err;
  }));
};

const codeOf = (err: unknown): string | undefined =>
  typeof err === "object" && err !== null
    ? (err as { code?: unknown }).code?.toString()
    : undefined;

const register = async (): Promise<void> => {
  const built = await ensureStarted();
  const connection = await readGoogleConnection();
  if (!connection) throw new GoogleNotConfiguredError();
  await built.handler.addTemplateClient("google", {
    instanceId: INSTANCE_ID,
    baseUrl: BASE_URL,
    serviceAccountEmail: connection.serviceAccountEmail,
    privateKey: connection.privateKey,
    scopes: SCOPES,
  });
  // A stop (or a restart) while this ran: the handler it registered on is gone.
  if (started === built) registeredAt = connection.updatedAt.getTime();
};

/**
 * The dianemo client name for the current connection. A connection changed
 * by another process has a newer `updatedAt`; this one then registers it
 * again (once, however many calls are waiting), so a rotated key reaches
 * every process. The key is opened only then.
 */
export const googleClient = async (): Promise<string> => {
  const stamp = await readGoogleStamp();
  if (!stamp) throw new GoogleNotConfiguredError();
  forgetIfStopped();
  while (registeredAt === undefined || stamp.getTime() > registeredAt) {
    await (registering ??= register().finally(() => {
      registering = undefined;
    }));
  }
  return buildClientName("google", { instanceId: INSTANCE_ID });
};

/** Stops the handler (its Redis listener, heartbeat and signal hooks); a no-op when it never started. */
export const stopGoogleHandler = async (): Promise<void> => {
  const current = started;
  started = undefined;
  startPromise = undefined;
  running = undefined;
  registering = undefined;
  registeredAt = undefined;
  await current?.handler.stop();
};

/** The plugin's Sheets calls: the one module tests mock. */
export const sheetsApi = {
  getSpreadsheet: async (...args: Parameters<typeof getSpreadsheet>) =>
    (await ensureStarted()).requests.google.getSpreadsheet(...args),
};

/**
 * Whether Google signs this key in. The plugin has no bare token call, so a
 * throwaway client is registered for the key and asked for a spreadsheet that
 * cannot exist: a 403/404 (`GGL_0009`) means the sign-in worked. A sign-in
 * Google refused (`GGL_0013`) or a key the plugin will not register is
 * `GoogleKeyRejectedError`; anything else is `GoogleUnavailableError`.
 */
export const checkServiceAccountKey = async (key: {
  client_email: string;
  private_key: string;
}): Promise<void> => {
  const { handler } = await ensureStarted();
  const instanceId = probeInstanceId();
  try {
    try {
      await handler.addTemplateClient("google", {
        instanceId,
        baseUrl: BASE_URL,
        serviceAccountEmail: key.client_email,
        privateKey: key.private_key,
        scopes: SCOPES,
      });
    } catch {
      throw new GoogleKeyRejectedError();
    }
    try {
      await sheetsApi.getSpreadsheet(
        buildClientName("google", { instanceId }),
        PROBE_SPREADSHEET_ID,
        { fields: "spreadsheetId" }
      );
    } catch (err) {
      const code = codeOf(err);
      if (code === "GGL_0009") return;
      if (code === "GGL_0013") throw new GoogleKeyRejectedError();
      throw new GoogleUnavailableError();
    }
  } finally {
    // The probe client holds the candidate key, encrypted, in Redis; if it
    // stays (this fails, or the process dies) the next start sweeps it.
    await handler.removeTemplateClient("google", instanceId).catch((err) => {
      logger.warn(
        { code: codeOf(err), instanceId },
        "Could not remove the Google key-check client; the next start sweeps it"
      );
    });
  }
};
