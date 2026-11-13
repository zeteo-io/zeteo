import type { PostgresSettings } from "../../adapters/postgres/settings.js";
import { prisma } from "../../utils/db/prisma.js";
import { fixtureSettings } from "./fixtureDb.js";
import { tokenFor } from "./tokens.js";
import { randomUUID } from "crypto";
import {
  SOURCES_READ,
  SOURCES_WRITE,
} from "../../definitions/tereoDeclaration.js";

export const writeToken = () => tokenFor({ permissions: [SOURCES_WRITE] });
export const readToken = () => tokenFor({ permissions: [SOURCES_READ] });

/** A slug no other test run uses. */
export const uniqueSlug = (prefix = "test") =>
  `${prefix}-${randomUUID().slice(0, 8)}`;

export const sourceBody = (
  settings: unknown,
  overrides: Record<string, unknown> = {}
) => ({
  slug: uniqueSlug(),
  name: "Sales",
  type: "postgres",
  settings,
  schemas: ["public"],
  ...overrides,
});

// The payload is the SDK's audit entry; each test reads the fields it needs.
/** The audit entries recorded for a resource, oldest first. */
export const auditRows = (id: string) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prisma.$queryRaw<Array<{ payload: Record<string, any> }>>`
    SELECT payload FROM "core"."core_outbox"
    WHERE payload->>'entityId' = ${id} ORDER BY created_at, id`;

/**
 * Deletes the sources, their grants and runs, and every audit row about them or their relations (a
 * relation's entries name the source in `metadata.source_id`).
 */
export const removeSources = async (ids: string[]) => {
  for (const id of ids) {
    await prisma.$executeRaw`
      DELETE FROM "core"."core_outbox"
      WHERE payload->>'entityId' = ${id}
         OR payload->'metadata'->>'source_id' = ${id}`;
  }
  // Grants and runs restrict deleting the tables and the sources they name.
  await prisma.queryRun.deleteMany({ where: { sourceId: { in: ids } } });
  await prisma.grant.deleteMany({
    where: { table: { sourceId: { in: ids } } },
  });
  await prisma.source.deleteMany({ where: { id: { in: ids } } });
};

/**
 * Fixture settings the service can dial: `localhost` may resolve to ::1 first,
 * where the test server is not listening, and the service takes the first
 * allowed address. Any other host (the compose service's name in Docker) is
 * used as it is.
 */
export const sourceSettings = (
  role: "ro" | "rw" | "owner" | "dbOwner",
  overrides: Partial<PostgresSettings> = {}
): PostgresSettings => {
  const base = fixtureSettings(role);
  return {
    ...base,
    host: base.host === "localhost" ? "127.0.0.1" : base.host,
    ...overrides,
  };
};

/** The audit rows of the relations with these ids, for cleanup. */
export const removeAuditRows = async (ids: string[]) => {
  for (const id of ids) {
    await prisma.$executeRaw`DELETE FROM "core"."core_outbox" WHERE payload->>'entityId' = ${id}`;
  }
};
