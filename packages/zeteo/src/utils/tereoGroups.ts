import { CORE_CLIENT, getHandler } from "@tereo-io/sdk/handler";

export interface TereoGroup {
  id: string;
  organizationId: string | null;
}

// These two requests stand in for the SDK's group requests until an SDK
// release carries them. Like the SDK's own, they reject with the HTTP error
// of a non-2xx answer.
const send = async <T>(requestName: string, url: string): Promise<T> =>
  (
    await getHandler().handleRequest<T>({
      clientName: CORE_CLIENT,
      requestName,
      method: "GET",
      url,
    })
  ).data;

/** `GET /v1/admin/users/:userId/groups`. */
export const listUserGroups = async (
  userId: string
): Promise<{ data: TereoGroup[] }> =>
  send(
    "core.groups.listForUser",
    `/v1/admin/users/${encodeURIComponent(userId)}/groups`
  );

/** `GET /v1/admin/groups/:id`. */
export const getGroup = async (id: string): Promise<unknown> =>
  send("core.groups.get", `/v1/admin/groups/${encodeURIComponent(id)}`);
