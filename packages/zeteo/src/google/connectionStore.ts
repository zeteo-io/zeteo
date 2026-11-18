import type { SealedSettings } from "../utils/crypto/envelope.js";
import { openSettings } from "../utils/crypto/envelope.js";
import { prisma } from "../utils/db/prisma.js";
import { z } from "zod";

export const PROVIDER = "google";
/** The sealed settings' additional authenticated data: the key cannot be moved to a source. */
export const SEAL_ID = "connection:google";

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

/**
 * What the row's JSON holds: the sealed key, and the account's email beside
 * it in the clear, so showing who the connection signs in as never opens the
 * seal. (The email is no secret; it is what a sheet is shared with.)
 */
export const StoredConnectionSchema = z.object({
  sealed: z.object({}).loose(),
  service_account_email: z.string(),
});
export type StoredConnection = z.infer<typeof StoredConnectionSchema>;

export interface GoogleConnectionView {
  serviceAccountEmail: string;
  updatedAt: Date;
  updatedBy: string;
}

export interface GoogleConnection extends GoogleConnectionView {
  privateKey: string;
}

/** The connection's email and stamps without opening its key; null when none is set or the row is unusable. */
export const readGoogleConnectionView =
  async (): Promise<GoogleConnectionView | null> => {
    const row = await prisma.connection.findUnique({
      where: { provider: PROVIDER },
      select: { sealedSettings: true, updatedAt: true, updatedBy: true },
    });
    if (!row) return null;
    const stored = StoredConnectionSchema.safeParse(row.sealedSettings);
    if (!stored.success) return null;
    return {
      serviceAccountEmail: stored.data.service_account_email,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
    };
  };

/** When the connection last changed, or null when none is set: the cheap check before using it. */
export const readGoogleStamp = async (): Promise<Date | null> =>
  (
    await prisma.connection.findUnique({
      where: { provider: PROVIDER },
      select: { updatedAt: true },
    })
  )?.updatedAt ?? null;

/** The stored connection with its key opened, or null when none is set. */
export const readGoogleConnection =
  async (): Promise<GoogleConnection | null> => {
    const row = await prisma.connection.findUnique({
      where: { provider: PROVIDER },
    });
    if (!row) return null;
    const stored = StoredConnectionSchema.parse(row.sealedSettings);
    const settings = SettingsSchema.parse(
      openSettings(stored.sealed as unknown as SealedSettings, SEAL_ID)
    );
    return {
      ...settings,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
    };
  };
