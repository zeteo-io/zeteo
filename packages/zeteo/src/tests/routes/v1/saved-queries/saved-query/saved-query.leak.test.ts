// @module-tag int
// @module-tag platform
import { DATA_READ } from "../../../../../definitions/tereoDeclaration.js";
import { savedQueriesCall } from "../../../../support/savedQueries.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../../../utils/db/prisma.js";
import { tokenFor } from "../../../../support/tokens.js";
import { randomUUID } from "crypto";
import {
  removeNoAccessCases,
  seedCauseSources,
  setUpNoAccessCases,
} from "../../../../support/savedQueryCauses.js";

// An organization A user who cannot run an available saved query learns
// nothing of why: the six causes look the same.

const stripped = (body: Record<string, unknown>) => {
  const {
    id: _id,
    name: _name,
    created_at: _c,
    updated_at: _u,
    shared_at: _s,
    last_run_at: _l,
    you_last_ran_at: _y,
    request_id: _r,
    ...rest
  } = body;
  return rest;
};

describe("available saved queries: six causes of no access look the same", () => {
  let sources: Awaited<ReturnType<typeof seedCauseSources>>;
  const users: string[] = [];
  const org = randomUUID();
  const inOrg = (id: string) =>
    tokenFor({ userId: id, permissions: [DATA_READ], org });

  beforeAll(async () => {
    sources = await seedCauseSources({}, "availleak");
    users.push(sources.owner.id);
  });
  afterAll(async () => {
    await removeNoAccessCases(sources, users);
  });

  it("answers list and get with the same body for each cause", async () => {
    const cases = await setUpNoAccessCases(sources, sources.owner);
    // The cases are shared; make each available too and read as the recipient in the org.
    const seen: Array<{ cause: string; list: unknown; get: unknown }> = [];
    for (const { cause, recipient, id } of cases) {
      users.push(recipient.id);
      await prisma.savedQuery.update({
        where: { id },
        data: { availableForDashboards: true, availableOrganizationId: org },
      });
      const avail = id;
      const list = await savedQueriesCall(
        "GET",
        "?scope=available",
        inOrg(recipient.id)
      );
      const get = await savedQueriesCall(
        "GET",
        `/${avail}`,
        inOrg(recipient.id)
      );
      expect(list.status, cause).toBe(200);
      expect(get.status, cause).toBe(200);
      const entry = list.body.data.find((s: { id: string }) => s.id === avail);
      expect(entry.accessible, cause).toBe(false);
      for (const body of [entry, get.body]) {
        expect(body, cause).not.toHaveProperty("query");
        expect(body, cause).not.toHaveProperty("source");
        expect(body, cause).not.toHaveProperty("used_by");
      }
      seen.push({ cause, list: stripped(entry), get: stripped(get.body) });
    }
    expect(seen).toHaveLength(6);
    for (const s of seen) {
      expect(s.list, s.cause).toEqual(seen[0]!.list);
      expect(s.get, s.cause).toEqual(seen[0]!.get);
    }
    expect(seen[0]!.list).toEqual(seen[0]!.get);
    for (const on of [sources.source, sources.archived, sources.missing]) {
      expect(JSON.stringify(seen)).not.toContain(on.slug);
    }
  });
});
