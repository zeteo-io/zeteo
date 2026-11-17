import { BASE_URL, fetchJson, type JsonResponse } from "./http.js";
import { prisma } from "../../utils/db/prisma.js";
import { uniqueName } from "./savedQueries.js";
import { BAR } from "./dashboards.js";

/** Any call to `/v1/saved-panels` + `path`. */
export const savedPanelsCall = (
  method: string,
  path: string,
  token: string,
  body?: unknown,
  baseUrl = BASE_URL
): Promise<JsonResponse> =>
  fetchJson(method, `${baseUrl}/v1/saved-panels${path}`, token, body);

/** Creates a saved panel on the saved query and returns its id; the create must succeed. */
export const savedPanelOf = async (
  token: string,
  savedQueryId: string,
  fields: Record<string, unknown> = {}
): Promise<string> => {
  const res = await savedPanelsCall("POST", "", token, {
    name: uniqueName("panel"),
    saved_query_id: savedQueryId,
    chart: BAR,
    ...fields,
  });
  if (res.status !== 201) {
    throw new Error(
      `saved panel not created: ${res.status} ${res.body?.error}`
    );
  }
  return res.body.id as string;
};

/** Shares a saved panel straight in the database, as the sharing routes do. */
export const shareSavedPanelDirectly = (
  savedPanelId: string,
  principal: { type: "user" | "group"; id: string },
  createdBy: string
) =>
  prisma.savedPanelShare.create({
    data: {
      savedPanelId,
      principalType: principal.type,
      principalId: principal.id,
      createdBy,
    },
  });

/** `POST /v1/dashboards/:id/panels/:panelId/detach` as `token`. */
export const detachPanel = (
  token: string,
  dashboardId: string,
  panelId: string
): Promise<JsonResponse> =>
  fetchJson(
    "POST",
    `${BASE_URL}/v1/dashboards/${dashboardId}/panels/${panelId}/detach`,
    token,
    undefined
  );
