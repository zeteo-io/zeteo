import { BASE_URL, fetchJson, type JsonResponse } from "./http.js";
import { DATA_READ } from "../../definitions/tereoDeclaration.js";
import { sourceBody, uniqueSlug, writeToken } from "./sources.js";
import type { EngineFixture } from "./engines.js";
import { prisma } from "../../utils/db/prisma.js";
import { grantsWriteToken } from "./grants.js";
import { tokenFor } from "./tokens.js";
import { randomUUID } from "crypto";

export interface SeededTable {
  id: string;
  /** Column ids by name. */
  columns: Record<string, string>;
}

export interface SeededSource {
  id: string;
  slug: string;
  /** By table name. */
  tables: Record<string, SeededTable>;
}

export interface Principal {
  type: "user" | "group";
  id: string;
}

/**
 * A source over the engine's fixture, registered (and so refreshed) through
 * the shared server's API. `fields` sets other source fields, such as
 * `timeout_ms` or `row_cap`.
 */
export const seedQuerySource = async (
  engine: EngineFixture,
  fields: Record<string, unknown> = {},
  slugPrefix = "query"
): Promise<SeededSource> => {
  const res = await fetchJson(
    "POST",
    `${BASE_URL}/v1/sources`,
    writeToken(),
    sourceBody(engine.sourceSettings(), {
      type: engine.type,
      slug: uniqueSlug(slugPrefix),
      schemas: engine.schemas,
      ...fields,
    })
  );
  if (res.status !== 201) {
    throw new Error(`source not created: ${res.status} ${res.body?.error}`);
  }
  const id = res.body.id as string;
  const tables = await prisma.sourceTable.findMany({
    where: { sourceId: id },
    include: { columns: true },
  });
  if (tables.length === 0) throw new Error("the source has no tables");
  return {
    id,
    slug: res.body.slug as string,
    tables: Object.fromEntries(
      tables.map((t) => [
        t.name,
        {
          id: t.id,
          columns: Object.fromEntries(t.columns.map((c) => [c.name, c.id])),
        },
      ])
    ),
  };
};

/** Grants `table` to `principal` through the API: every column, or these by name. Returns the grant's id. */
export const grantTo = async (
  principal: Principal,
  table: SeededTable,
  columns: string[] | "all"
): Promise<string> => {
  const res = await fetchJson(
    "POST",
    `${BASE_URL}/v1/grants`,
    grantsWriteToken(),
    {
      principal_type: principal.type,
      principal_id: principal.id,
      table_id: table.id,
      ...(columns === "all"
        ? { all_columns: true }
        : {
            all_columns: false,
            column_ids: columns.map((name) => {
              const id = table.columns[name];
              if (!id) throw new Error(`no column ${name}`);
              return id;
            }),
          }),
    }
  );
  if (res.status !== 201) {
    throw new Error(`grant not created: ${res.status} ${res.body?.error}`);
  }
  return res.body.id as string;
};

export const removeGrant = async (grantId: string): Promise<void> => {
  const res = await fetchJson(
    "DELETE",
    `${BASE_URL}/v1/grants/${grantId}`,
    grantsWriteToken()
  );
  if (res.status !== 204) throw new Error(`grant not removed: ${res.status}`);
};

/** A user who may query, and their token. */
export const newQueryUser = () => {
  const id = randomUUID();
  return {
    principal: { type: "user" as const, id },
    id,
    token: tokenFor({ userId: id, permissions: [DATA_READ] }),
  };
};

/** `POST /v1/query` as `token`, on the shared server unless `baseUrl` says otherwise. */
export const postQuery = (
  token: string,
  body: unknown,
  baseUrl = BASE_URL
): Promise<JsonResponse> =>
  fetchJson("POST", `${baseUrl}/v1/query`, token, body);

/** The runs recorded for these users, oldest first. */
export const runsOf = (userIds: string[]) =>
  prisma.queryRun.findMany({
    where: { userId: { in: userIds } },
    orderBy: { id: "asc" },
  });

/**
 * Deletes the runs of these users and their audit entries; `removeSources`
 * takes care of the rest, but not of runs whose source never resolved.
 */
export const removeRunsOf = async (userIds: string[]): Promise<void> => {
  const runs = await runsOf(userIds);
  for (const { id } of runs) {
    await prisma.$executeRaw`DELETE FROM "core"."core_outbox" WHERE payload->>'entityId' = ${id}`;
  }
  await prisma.queryRun.deleteMany({ where: { userId: { in: userIds } } });
};
