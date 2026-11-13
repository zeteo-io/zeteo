import { prisma } from "../../utils/db/prisma.js";
import { BASE_URL, fetchJson } from "./http.js";
import { grantsWriteToken } from "./grants.js";

/** Gives the principal its own limits through the shared server's API; returns the row's id. */
export const setPrincipalLimit = async (
  principal: { type: "user" | "group"; id: string },
  limits: { query_concurrency?: number; export_concurrency?: number }
): Promise<string> => {
  const res = await fetchJson(
    "POST",
    `${BASE_URL}/v1/principal-limits`,
    grantsWriteToken(),
    { principal_type: principal.type, principal_id: principal.id, ...limits }
  );
  if (res.status !== 201) {
    throw new Error(`limits not created: ${res.status} ${res.body?.error}`);
  }
  return res.body.id as string;
};

/** Removes every limit row of these principal ids, and their audit entries. */
export const removePrincipalLimits = async (
  principalIds: string[]
): Promise<void> => {
  const rows = await prisma.principalLimit.findMany({
    where: { principalId: { in: principalIds } },
    select: { id: true },
  });
  for (const { id } of rows) {
    await prisma.$executeRaw`DELETE FROM "core"."core_outbox" WHERE payload->>'entityId' = ${id}`;
  }
  await prisma.principalLimit.deleteMany({
    where: { principalId: { in: principalIds } },
  });
};
