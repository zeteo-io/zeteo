import { runInTransactionScope, getTereo } from "./tereo.js";
import type { AuditLogWritableAction } from "@tereo-io/sdk";
import { collector } from "./outboxCollector.js";
import type { Prisma } from "./db/prisma.js";
import { prisma } from "./db/prisma.js";
import env from "../env.js";
import {
  AUDIT_EVENTS,
  type AuditEvent,
} from "../definitions/tereoDeclaration.js";

export interface AuditEntry {
  action: AuditEvent;
  resourceType: string;
  resourceId: string;
  /** The tereo user who made the change. */
  actorId: string;
  metadata?: Record<string, unknown>;
}

export type Audit = (entry: AuditEntry) => void;

// Tereo's audit entries carry one of six verbs; the event name stays in the
// entry's metadata, so nothing of it is lost.
const VERB: Record<AuditEvent, AuditLogWritableAction> = {
  [AUDIT_EVENTS.sourceCreated]: "CREATE",
  [AUDIT_EVENTS.sourceUpdated]: "UPDATE",
  [AUDIT_EVENTS.sourceArchived]: "ARCHIVE",
  [AUDIT_EVENTS.sourceRefreshed]: "UPDATE",
  [AUDIT_EVENTS.relationDeclared]: "CREATE",
  [AUDIT_EVENTS.relationRemoved]: "DELETE",
  [AUDIT_EVENTS.grantCreated]: "CREATE",
  [AUDIT_EVENTS.grantUpdated]: "UPDATE",
  [AUDIT_EVENTS.grantRemoved]: "DELETE",
  [AUDIT_EVENTS.queryRun]: "CREATE",
};

export interface WithAuditOptions {
  /** How long the transaction may run; DB_TRANSACTION_TIMEOUT_MS when unset. */
  timeoutMs?: number;
}

/**
 * Runs `fn` in one transaction. `audit` records an entry; when `fn` returns,
 * the entries go to `core.outbox` in that same transaction, in order, so they
 * exist exactly when the change commits. An entry tereo would refuse fails
 * the transaction. A lock wait longer than DB_LOCK_TIMEOUT_MS fails it too
 * (503, `isDatabaseBusy`).
 */
export const withAudit = async <T>(
  fn: (tx: Prisma.TransactionClient, audit: Audit) => Promise<T>,
  options: WithAuditOptions = {}
): Promise<T> => {
  const entries: AuditEntry[] = [];
  return prisma.$transaction(
    async (tx) => {
      // SET takes no parameters; the value is an integer from the env schema.
      await tx.$executeRawUnsafe(
        `SET LOCAL lock_timeout = ${env.DB_LOCK_TIMEOUT_MS}`
      );
      const result = await runInTransactionScope(() =>
        fn(tx, (entry) => {
          entries.push(entry);
        })
      );
      if (entries.length > 0) {
        const { outbox } = getTereo();
        const pending = collector();
        for (const entry of entries) {
          await outbox.audit(pending.client, {
            userId: entry.actorId,
            action: VERB[entry.action],
            entityType: entry.resourceType,
            entityId: entry.resourceId,
            metadata: { ...entry.metadata, event: entry.action },
          });
        }
        await pending.flush(tx);
      }
      return result;
    },
    options.timeoutMs === undefined ? undefined : { timeout: options.timeoutMs }
  );
};
