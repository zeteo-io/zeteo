import { expectJson, requestJson } from "./http.js";
import { stack } from "./stack.js";

/** Tereo's admin API, called with a token from Tereo's own UI client. */

const url = (path: string) => `${stack.tereoUrl}${path}`;

export const ADMIN_EMAIL = "admin@e2e.example.com";

/** Creates the first admin with the run's setup token, unless setup is done. */
export const completeSetup = async (): Promise<void> => {
  const status = await expectJson(200, "GET", url("/v1/setup/status"));
  if (status.setupComplete) return;
  await expectJson(201, "POST", url("/v1/setup"), {
    body: {
      token: stack.setupToken,
      admin: {
        email: ADMIN_EMAIL,
        name: "E2E Admin",
        password: stack.userPassword,
      },
      organization: { name: "E2E", slug: "e2e", code: "E2E" },
    },
  });
};

/** The id of the role named `name` (a service's system role or a custom one). */
export const roleId = async (token: string, name: string): Promise<string> => {
  const page = await expectJson(
    200,
    "GET",
    url(
      `/v1/admin/roles?${new URLSearchParams({ "filter[name]": name, limit: "100" })}`
    ),
    { token }
  );
  const role = (page.data as Array<{ id: string; name: string }>).find(
    (r) => r.name === name
  );
  if (!role) throw new Error(`Tereo has no role ${name}`);
  return role.id;
};

/** A password user holding `roleIds` directly; returns the user's id. */
export const createUser = async (
  token: string,
  email: string,
  roleIds: string[]
): Promise<string> => {
  const user = await expectJson(201, "POST", url("/v1/admin/users"), {
    token,
    body: { email, name: email.split("@")[0], password: stack.userPassword },
  });
  if (roleIds.length > 0) {
    await expectJson(200, "PUT", url(`/v1/admin/users/${user.id}/roles`), {
      token,
      body: { roleIds },
    });
  }
  return user.id as string;
};

export const createGroup = async (
  token: string,
  slug: string
): Promise<string> => {
  const group = await expectJson(201, "POST", url("/v1/admin/groups"), {
    token,
    body: { slug, name: slug },
  });
  return group.id as string;
};

export const addGroupMember = (
  token: string,
  groupId: string,
  userId: string
) =>
  expectJson(200, "POST", url(`/v1/admin/groups/${groupId}/members`), {
    token,
    body: { userIds: [userId] },
  });

export const removeGroupMember = (
  token: string,
  groupId: string,
  userId: string
) =>
  expectJson(
    204,
    "DELETE",
    url(`/v1/admin/groups/${groupId}/members/${userId}`),
    { token }
  );

/** The user's groups as Tereo answers zeteo's own lookup. */
export const userGroups = (token: string, userId: string) =>
  requestJson("GET", url(`/v1/admin/users/${userId}/groups`), { token });

export interface ServiceAccessRow {
  id: string;
  kind: string;
  target: string;
  status: string;
}

/** The service `slug` with its access rows. */
export const getService = async (
  token: string,
  slug: string
): Promise<{ id: string; access: ServiceAccessRow[] }> => {
  const page = await expectJson(
    200,
    "GET",
    url(`/v1/admin/services?${new URLSearchParams({ "filter[slug]": slug })}`),
    { token }
  );
  const found = (page.data as Array<{ id: string; slug: string }>).find(
    (s) => s.slug === slug
  );
  if (!found) throw new Error(`Tereo has no service ${slug}`);
  return expectJson(200, "GET", url(`/v1/admin/services/${found.id}`), {
    token,
  });
};

/** Revokes access rows of a service, which revokes every access token its client holds. */
export const revokeServiceAccess = (
  token: string,
  serviceId: string,
  ids: string[]
) =>
  expectJson(
    200,
    "POST",
    url(`/v1/admin/services/${serviceId}/access/revoke`),
    {
      token,
      body: { ids },
    }
  );

export const approveServiceAccess = (
  token: string,
  serviceId: string,
  ids: string[]
) =>
  expectJson(
    200,
    "POST",
    url(`/v1/admin/services/${serviceId}/access/approve`),
    { token, body: { ids } }
  );

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId: string;
  userId: string | null;
  source: string;
  metadata: Record<string, unknown> | null;
}

/** zeteo's audit entries for one entity; zeteo writes them with no organization. */
export const zeteoAuditEntries = async (
  token: string,
  entityId: string
): Promise<AuditEntry[]> => {
  const page = await expectJson(
    200,
    "GET",
    url(
      `/v1/audit/entries?${new URLSearchParams({
        "filter[source]": "zeteo",
        "filter[organizationId]": "none",
        "filter[entityId]": entityId,
      })}`
    ),
    { token }
  );
  return page.data as AuditEntry[];
};
