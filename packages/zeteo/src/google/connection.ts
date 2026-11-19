import { connectionView, type ConnectionView } from "../views/connection.js";
import { AUDIT_EVENTS } from "../definitions/tereoDeclaration.js";
import { sealSettings } from "../utils/crypto/envelope.js";
import { checkServiceAccountKey } from "./handler.js";
import { withAudit } from "../utils/transaction.js";
import type { Caller } from "../middleware/auth.js";
import {
  PROVIDER,
  SEAL_ID,
  type ServiceAccountKey,
  type StoredConnection,
} from "./connectionStore.js";

export {
  ServiceAccountKeySchema,
  readGoogleConnection,
  type ServiceAccountKey,
} from "./connectionStore.js";

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
  const stored = {
    sealed: sealSettings(
      { serviceAccountEmail: key.client_email, privateKey: key.private_key },
      SEAL_ID
    ) as unknown as object,
    service_account_email: key.client_email,
  } satisfies Record<keyof StoredConnection, unknown>;
  const row = await withAudit(async (tx, audit) => {
    const saved = await tx.connection.upsert({
      where: { provider: PROVIDER },
      create: {
        provider: PROVIDER,
        sealedSettings: stored,
        updatedBy: caller.userId,
      },
      update: { sealedSettings: stored, updatedBy: caller.userId },
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
