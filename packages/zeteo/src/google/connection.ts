import { connectionView, type ConnectionView } from "../views/connection.js";
import { openSettings, sealSettings } from "../utils/crypto/envelope.js";
import type { SealedSettings } from "../utils/crypto/envelope.js";
import { AUDIT_EVENTS } from "../definitions/tereoDeclaration.js";
import { checkServiceAccountKey } from "./handler.js";
import { withAudit } from "../utils/transaction.js";
import type { Caller } from "../middleware/auth.js";
import { prisma } from "../utils/db/prisma.js";
import { z } from "zod";

const PROVIDER = "google";
/** The sealed settings' additional authenticated data: the key cannot be moved to a source. */
const SEAL_ID = "connection:google";

/** A service account's JSON key: what is read is checked, the rest passes through unread. */
export const ServiceAccountKeySchema = z.looseObject({
  type: z.literal("service_account"),
  client_email: z.string().email(),
  private_key: z.string().startsWith("-----BEGIN PRIVATE KEY-----"),
});
export type ServiceAccountKey = z.infer<typeof ServiceAccountKeySchema>;

const SettingsSchema = z.object({
  serviceAccountEmail: z.string(),
  privateKey: z.string(),
});

export interface GoogleConnection {
  serviceAccountEmail: string;
  privateKey: string;
  updatedAt: Date;
  updatedBy: string;
}

/** The stored connection with its key opened, or null when none is set. */
export const readGoogleConnection =
  async (): Promise<GoogleConnection | null> => {
    const row = await prisma.connection.findUnique({
      where: { provider: PROVIDER },
    });
    if (!row) return null;
    const settings = SettingsSchema.parse(
      openSettings(row.sealedSettings as unknown as SealedSettings, SEAL_ID)
    );
    return {
      ...settings,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
    };
  };

/** The email of the stored connection, without opening its key. */
export const readGoogleConnectionView =
  async (): Promise<ConnectionView | null> => {
    const connection = await readGoogleConnection();
    return connection ? connectionView(connection) : null;
  };

/**
 * Replaces the connection. Google signs the key in first (outside any
 * transaction, as nothing here calls out inside one); a key it refuses is
 * 422 `google_key_rejected` and nothing is stored.
 */
export const putGoogleConnection = async (
  caller: Pick<Caller, "userId">,
  key: ServiceAccountKey
): Promise<ConnectionView> => {
  await checkServiceAccountKey({
    client_email: key.client_email,
    private_key: key.private_key,
  });
  const sealed = sealSettings(
    { serviceAccountEmail: key.client_email, privateKey: key.private_key },
    SEAL_ID
  ) as unknown as object;
  const row = await withAudit(async (tx, audit) => {
    const saved = await tx.connection.upsert({
      where: { provider: PROVIDER },
      create: {
        provider: PROVIDER,
        sealedSettings: sealed,
        updatedBy: caller.userId,
      },
      update: { sealedSettings: sealed, updatedBy: caller.userId },
    });
    audit({
      action: AUDIT_EVENTS.connectionUpdated,
      resourceType: "connection",
      resourceId: PROVIDER,
      actorId: caller.userId,
      metadata: { provider: PROVIDER, service_account_email: key.client_email },
    });
    return saved;
  });
  return connectionView({
    serviceAccountEmail: key.client_email,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  });
};
