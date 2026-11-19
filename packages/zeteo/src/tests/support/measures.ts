import { grantTo, removeRunsOf, type SeededSource } from "./queries.js";
import { fetchJson, type JsonResponse } from "./http.js";
import { tokenFor } from "./tokens.js";
import { randomUUID } from "crypto";
import {
  DATA_READ,
  MEASURES_WRITE,
  SOURCES_READ,
  SOURCES_WRITE,
} from "../../definitions/tereoDeclaration.js";

/** An admin who sees every measure and manages editors, but is no editor until listed. */
export const measuresAdminToken = (userId: string = randomUUID()) =>
  tokenFor({
    userId,
    permissions: [SOURCES_READ, SOURCES_WRITE, DATA_READ, MEASURES_WRITE],
  });

/** A `zeteo_user`: may query and hold `zeteo.measures.write`, an editor only where listed. */
export const measureUser = () => {
  const id = randomUUID();
  return {
    id,
    principal: { type: "user" as const, id },
    token: tokenFor({ userId: id, permissions: [DATA_READ, MEASURES_WRITE] }),
  };
};

/** `method` on `/v1/sources<path>` of the app at `baseUrl`. */
export const sourcesApi =
  (baseUrl: () => string) =>
  (
    method: string,
    path: string,
    token: string,
    body?: unknown
  ): Promise<JsonResponse> =>
    fetchJson(method, `${baseUrl()}/v1/sources${path}`, token, body);

/** Replaces the source's measure editors as an admin; throws unless it is done. */
export const setEditors = async (
  baseUrl: string,
  sourceId: string,
  principals: { type: "user" | "group"; id: string }[]
): Promise<void> => {
  const res = await fetchJson(
    "PUT",
    `${baseUrl}/v1/sources/${sourceId}/measure-editors`,
    measuresAdminToken(),
    { principals }
  );
  if (res.status !== 200) {
    throw new Error(
      `editors not set: ${res.status} ${JSON.stringify(res.body)}`
    );
  }
};

/** A measure's body on the fixture's `orders` table. */
export const measureBody = (
  name: string,
  formula: unknown,
  where?: unknown
) => ({
  name,
  description: `The ${name.replaceAll("_", " ")}`,
  table: "orders",
  formula,
  ...(where !== undefined && { where }),
});

/** The fixture's three measures: total_revenue, paid_revenue (uses it) and paid_ytd (uses that). */
export const STANDARD_MEASURES = [
  measureBody("total_revenue", { sum: "total" }),
  measureBody(
    "paid_revenue",
    { measure: "total_revenue" },
    { status: { eq: "paid" } }
  ),
  measureBody(
    "paid_ytd",
    { measure: "paid_revenue" },
    {
      created_at: {
        gte: { relative: { unit: "year", offset: 0, startOf: true } },
      },
    }
  ),
];

/** Creates each measure through the API as `token`, in order; returns their ids by name. */
export const createMeasures = async (
  baseUrl: string,
  sourceId: string,
  token: string,
  bodies: unknown[]
): Promise<Record<string, string>> => {
  const ids: Record<string, string> = {};
  for (const body of bodies) {
    const res = await fetchJson(
      "POST",
      `${baseUrl}/v1/sources/${sourceId}/measures`,
      token,
      body
    );
    if (res.status !== 201) {
      throw new Error(
        `measure not created: ${res.status} ${JSON.stringify(res.body)}`
      );
    }
    ids[res.body.name as string] = res.body.id as string;
  }
  return ids;
};

/** A response without its `request_id`: what two refusals are compared by. */
export const withoutRequestId = (res: JsonResponse) => {
  const { request_id: _id, ...rest } = (res.body ?? {}) as Record<
    string,
    unknown
  >;
  return { status: res.status, body: rest };
};

/**
 * Creates `bodies` on `source` through the shared server's API, as a fresh
 * editor granted every table of the source (so each measure is visible to
 * them); returns the ids by name.
 */
export const seedMeasures = async (
  baseUrl: string,
  source: SeededSource,
  bodies: unknown[]
): Promise<Record<string, string>> => {
  const editor = measureUser();
  for (const table of Object.values(source.tables)) {
    await grantTo(editor.principal, table, "all");
  }
  await setEditors(baseUrl, source.id, [editor.principal]);
  try {
    return await createMeasures(baseUrl, source.id, editor.token, bodies);
  } finally {
    await removeRunsOf([editor.id]);
  }
};
