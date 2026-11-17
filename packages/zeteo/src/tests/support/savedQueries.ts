import { grantTo, newQueryUser, type SeededSource } from "./queries.js";
import { BASE_URL, fetchJson, type JsonResponse } from "./http.js";
import { prisma } from "../../utils/db/prisma.js";
import { randomUUID } from "crypto";

/** A name no other saved query of the test run has. */
export const uniqueName = (prefix = "saved") =>
  `${prefix} ${randomUUID().slice(0, 8)}`;

/** A query over `orders` of the source. */
export const ordersQuery = (
  source: SeededSource,
  select: string[] = ["id", "status"]
) => ({ source: source.slug, from: "orders", select });

/** A user who may query and is granted these columns of `orders`. */
export const userWithOrders = async (
  source: SeededSource,
  columns: string[] | "all" = ["id", "status"]
) => {
  const user = newQueryUser();
  await grantTo(user.principal, source.tables.orders!, columns);
  return user;
};

/** `POST /v1/saved-queries` as `token`. */
export const createSavedQuery = (
  token: string,
  body: unknown,
  baseUrl = BASE_URL
): Promise<JsonResponse> =>
  fetchJson("POST", `${baseUrl}/v1/saved-queries`, token, body);

/** Any call to `/v1/saved-queries` + `path`. */
export const savedQueriesCall = (
  method: string,
  path: string,
  token: string,
  body?: unknown,
  baseUrl = BASE_URL
): Promise<JsonResponse> =>
  fetchJson(method, `${baseUrl}/v1/saved-queries${path}`, token, body);

/** Creates a saved query and returns its id; the create must succeed. */
export const savedQueryOf = async (
  token: string,
  source: SeededSource,
  fields: Record<string, unknown> = {}
): Promise<string> => {
  const res = await createSavedQuery(token, {
    name: uniqueName(),
    query: ordersQuery(source),
    ...fields,
  });
  if (res.status !== 201) {
    throw new Error(
      `saved query not created: ${res.status} ${res.body?.error}`
    );
  }
  return res.body.id as string;
};

/** Shares a saved query straight in the database, as the sharing routes do. */
export const shareDirectly = (
  savedQueryId: string,
  principal: { type: "user" | "group"; id: string },
  createdBy: string
) =>
  prisma.savedQueryShare.create({
    data: {
      savedQueryId,
      principalType: principal.type,
      principalId: principal.id,
      createdBy,
    },
  });
