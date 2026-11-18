import google, { type getSpreadsheet } from "@dianemo/plugin-google";
import RequestHandler, { buildClientName } from "@dianemo/core";
import { readGoogleConnection } from "./connection.js";
import { redisBackend } from "@dianemo/backend-redis";
import { hkdfSync, randomUUID } from "node:crypto";
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

let started: ReturnType<typeof build> | undefined;
/** The `updatedAt` of the connection this process last registered. */
let registeredAt: number | undefined;

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

const codeOf = (err: unknown): string | undefined =>
  typeof err === "object" && err !== null
    ? (err as { code?: unknown }).code?.toString()
    : undefined;

/**
 * The dianemo client name for the current connection. A connection changed
 * by another process has a newer `updatedAt`; this one then registers it
 * again, so a rotated key reaches every process.
 */
export const googleClient = async (): Promise<string> => {
  const connection = await readGoogleConnection();
  if (!connection) throw new GoogleNotConfiguredError();
  const { handler } = ensureHandler();
  const at = connection.updatedAt.getTime();
  if (registeredAt !== at) {
    await handler.addTemplateClient("google", {
      instanceId: INSTANCE_ID,
      baseUrl: BASE_URL,
      serviceAccountEmail: connection.serviceAccountEmail,
      privateKey: connection.privateKey,
      scopes: SCOPES,
    });
    registeredAt = at;
  }
  return buildClientName("google", { instanceId: INSTANCE_ID });
};

/** The plugin's Sheets calls: the one module tests mock. */
export const sheetsApi = {
  getSpreadsheet: (...args: Parameters<typeof getSpreadsheet>) =>
    ensureHandler().requests.google.getSpreadsheet(...args),
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
  const { handler } = ensureHandler();
  const instanceId = `validate-${randomUUID()}`;
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
    await handler.removeTemplateClient("google", instanceId).catch(() => {
      // The throwaway client holds a key Google already judged; leaving it is harmless.
    });
  }
};
