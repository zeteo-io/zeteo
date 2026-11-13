import type { RequestConfig } from "@dianemo/core";
import {
  CORE_CLIENT,
  getHandler,
  purgeServiceToken,
} from "@tereo-io/sdk/handler";

export interface TereoGroup {
  id: string;
  organizationId: string | null;
}

/** One escaped path segment; an empty, `.` or `..` one would reach another route. */
const pathSegment = (value: string): string => {
  if (value === "" || value === "." || value === "..") {
    throw new Error(`Path parameter ${JSON.stringify(value)} cannot be sent`);
  }
  return encodeURIComponent(value);
};

const statusOf = (err: unknown): unknown =>
  (err as { response?: { status?: unknown } } | null)?.response?.status;

// These requests stand in for the SDK's group requests until an SDK release
// carries them, and send as the SDK's do: they reject with the HTTP error of
// a non-2xx answer, and a 401 (a service token core no longer accepts) gets
// one retry with a fresh token.
const send = async <T>(requestName: string, url: string): Promise<T> => {
  const config: RequestConfig<unknown> = {
    clientName: CORE_CLIENT,
    requestName,
    method: "GET",
    url,
  };
  try {
    return (await getHandler().handleRequest<T>(config)).data;
  } catch (err) {
    if (statusOf(err) !== 401) throw err;
    await purgeServiceToken();
    return (await getHandler().handleRequest<T>(config)).data;
  }
};

/** `GET /v1/admin/users/:userId/groups`. */
export const listUserGroups = async (
  userId: string
): Promise<{ data: TereoGroup[] }> =>
  send(
    "core.groups.listForUser",
    `/v1/admin/users/${pathSegment(userId)}/groups`
  );

/** `GET /v1/admin/groups/:id`. */
export const getGroup = async (id: string): Promise<unknown> =>
  send("core.groups.get", `/v1/admin/groups/${pathSegment(id)}`);
