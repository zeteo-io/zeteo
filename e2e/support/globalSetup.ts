import { completeSetup, createUser, createGroup, roleId } from "./tereo.js";
import { expectJson, waitFor } from "./http.js";
import type { TestProject } from "vitest/node";
import { CLIENTS, stack } from "./stack.js";
import { ADMIN_EMAIL } from "./tereo.js";
import { signIn } from "./oauth.js";
import {
  grantTable,
  registerSource,
  sourceSettings,
  tableIds,
} from "./zeteo.js";

/**
 * What every file shares: Tereo set up with its first admin, the run's users
 * and group, and a source on zeteo (TLS without certificate verification)
 * with the grants the cases rely on. Tokens are real, from Tereo's sign-in.
 */
export interface E2eContext {
  admin: { id: string; coreToken: string; zeteoToken: string };
  alice: { id: string; email: string; token: string };
  bob: { id: string; email: string; token: string };
  dave: { id: string; email: string; token: string };
  groupId: string;
  groupGrantId: string;
  source: { id: string; slug: string; tables: Record<string, string> };
}

declare module "vitest" {
  export interface ProvidedContext {
    e2e: E2eContext;
  }
}

/** The source the query, group, audit and MCP cases use. */
export const SOURCE_SLUG = "sales";

const healthy = (url: string) =>
  waitFor(
    `${url}/health`,
    async () => {
      try {
        return (await fetch(`${url}/health`)).ok ? true : undefined;
      } catch {
        return undefined;
      }
    },
    { timeoutMs: 60_000 }
  );

export default async function setup(project: TestProject): Promise<void> {
  await Promise.all([
    healthy(stack.tereoUrl),
    healthy(stack.zeteoUrl),
    healthy(stack.zeteoCaUrl),
  ]);
  await completeSetup();

  const coreToken = await signIn({
    client: CLIENTS.tereoUi,
    email: ADMIN_EMAIL,
  });
  const me = await expectJson(200, "GET", `${stack.tereoUrl}/v1/account/me`, {
    token: coreToken,
  });
  const adminId = (me.id ?? me.user?.id) as string;
  const zeteoToken = await signIn({
    client: CLIENTS.web,
    email: ADMIN_EMAIL,
    clientSecret: stack.webClientSecret,
  });

  const userRole = await roleId(coreToken, "zeteo_user");
  const mcpRole = await roleId(coreToken, "zeteo_mcp_user");
  const person = async (name: string, roles: string[]) => {
    const email = `${name}@e2e.example.com`;
    const id = await createUser(coreToken, email, roles);
    const token = await signIn({
      client: CLIENTS.web,
      email,
      clientSecret: stack.webClientSecret,
    });
    return { id, email, token };
  };
  // alice is granted tables herself and may use MCP; bob only through the
  // group; dave is the user of the service-token case.
  const alice = await person("alice", [mcpRole]);
  const bob = await person("bob", [userRole]);
  const dave = await person("dave", [userRole]);
  const groupId = await createGroup(coreToken, "e2e-analysts");

  const created = await registerSource(
    stack.zeteoUrl,
    zeteoToken,
    SOURCE_SLUG,
    sourceSettings("require")
  );
  if (created.status !== 201) {
    throw new Error(
      `registering the source: ${created.status} ${JSON.stringify(created.body)}`
    );
  }
  const sourceId = created.body.id as string;
  const tables = await tableIds(stack.zeteoUrl, zeteoToken, sourceId);
  const grant = (type: "user" | "group", id: string, table: string) =>
    grantTable(stack.zeteoUrl, zeteoToken, { type, id }, tables[table]);
  await grant("user", alice.id, "orders");
  await grant("user", alice.id, "customers");
  await grant("user", adminId, "orders");
  await grant("user", dave.id, "orders");
  const groupGrant = await grant("group", groupId, "orders");

  project.provide("e2e", {
    admin: { id: adminId, coreToken, zeteoToken },
    alice,
    bob,
    dave,
    groupId,
    groupGrantId: groupGrant.id as string,
    source: { id: sourceId, slug: SOURCE_SLUG, tables },
  });
}
