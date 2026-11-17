// @module-tag int
// @module-tag platform
import { removeSources, writeToken } from "../../../support/sources.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASE_URL, fetchJson } from "../../../support/http.js";
import { prisma } from "../../../../utils/db/prisma.js";
import { ENGINES } from "../../../support/engines.js";
import {
  createSavedQuery,
  savedQueriesCall,
  shareDirectly,
  uniqueName,
} from "../../../support/savedQueries.js";
import {
  grantTo,
  newQueryUser,
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../../../support/queries.js";

// A recipient who cannot run a saved query learns nothing of why: for each of
// the six causes the list entry and the GET answer are the same, but for the
// ids, the name and the timestamps.

const QUERY_COLUMNS = ["id", "status", "customers.region"];
const queryOn = (on: SeededSource) => ({
  source: on.slug,
  from: "orders",
  join: ["customers"],
  select: QUERY_COLUMNS,
});

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

describe("saved queries: six causes of no access look the same", () => {
  let source: SeededSource;
  let archived: SeededSource;
  let missing: SeededSource;
  const ownerUser = newQueryUser();
  const owners = [ownerUser.id];

  /** The owner's saved query on `on`, shared with `recipient`. */
  const sharedWith = async (on: SeededSource, recipient: { id: string }) => {
    const owner = ownerUser;
    const made = await createSavedQuery(owner.token, {
      name: uniqueName(),
      query: queryOn(on),
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    await shareDirectly(
      made.body.id,
      { type: "user", id: recipient.id },
      owner.id
    );
    return { owner, id: made.body.id as string };
  };

  beforeAll(async () => {
    source = await seedQuerySource(ENGINES[0]!, {}, "leaka");
    archived = await seedQuerySource(ENGINES[0]!, {}, "leakb");
    missing = await seedQuerySource(ENGINES[0]!, {}, "leakc");
    // One owner for every saved query, so the owner is the same in each answer.
    for (const on of [source, archived, missing]) {
      for (const table of ["orders", "customers"]) {
        await grantTo(ownerUser.principal, on.tables[table]!, "all");
      }
    }
  });
  afterAll(async () => {
    await removeRunsOf(owners);
    await removeSources([source.id, archived.id, missing.id]);
  });

  it("answers list and get with the same body for each cause", async () => {
    const seen: Array<{ cause: string; list: unknown; get: unknown }> = [];
    const observe = async (
      cause: string,
      recipient: { id: string; token: string },
      id: string
    ) => {
      const list = await savedQueriesCall(
        "GET",
        "?scope=shared",
        recipient.token
      );
      const get = await savedQueriesCall("GET", `/${id}`, recipient.token);
      expect(list.status, cause).toBe(200);
      expect(get.status, cause).toBe(200);
      const entry = list.body.data.find((s: { id: string }) => s.id === id);
      expect(entry.accessible, cause).toBe(false);
      for (const body of [entry, get.body]) {
        expect(body, cause).not.toHaveProperty("query");
        expect(body, cause).not.toHaveProperty("source");
      }
      seen.push({
        cause,
        list: stripped(entry),
        get: stripped(get.body),
      });
    };

    // 1. an ungranted column
    const column = newQueryUser();
    await grantTo(column.principal, source.tables.orders!, ["id"]);
    await grantTo(column.principal, source.tables.customers!, "all");
    // 2. an ungranted table
    const table = newQueryUser();
    await grantTo(table.principal, source.tables.customers!, "all");
    // 3. a relation not visible: the key column of customers is not granted
    const relation = newQueryUser();
    await grantTo(relation.principal, source.tables.orders!, "all");
    await grantTo(relation.principal, source.tables.customers!, ["region"]);
    // 4. an archived source
    const arch = newQueryUser();
    // 5. no grant at all
    const none = newQueryUser();
    // 6. a column that is now missing
    const gone = newQueryUser();

    const cases: Array<[string, SeededSource, { id: string; token: string }]> =
      [
        ["an ungranted column", source, column],
        ["an ungranted table", source, table],
        ["a relation not visible", source, relation],
        ["an archived source", archived, arch],
        ["no grant at all", source, none],
        ["a missing column", missing, gone],
      ];
    const ids = new Map<string, string>();
    for (const [cause, on, recipient] of cases) {
      if (cause === "an archived source" || cause === "a missing column") {
        for (const t of ["orders", "customers"]) {
          await grantTo(
            { type: "user", id: recipient.id },
            on.tables[t]!,
            "all"
          );
        }
      }
      ids.set(cause, (await sharedWith(on, recipient)).id);
    }

    const archive = await fetchJson(
      "POST",
      `${BASE_URL}/v1/sources/${archived.id}/archive`,
      writeToken()
    );
    expect(archive.status).toBe(204);
    await prisma.sourceColumn.updateMany({
      where: { tableId: missing.tables.orders!.id, name: "status" },
      data: { missingSince: new Date() },
    });

    for (const [cause, , recipient] of cases) {
      await observe(cause, recipient, ids.get(cause)!);
    }

    expect(seen).toHaveLength(6);
    for (const s of seen) {
      expect(s.list, s.cause).toEqual(seen[0]!.list);
      expect(s.get, s.cause).toEqual(seen[0]!.get);
    }
    // The list entry and the single answer differ in nothing either.
    expect(seen[0]!.list).toEqual(seen[0]!.get);
    for (const slug of [source.slug, archived.slug, missing.slug]) {
      expect(JSON.stringify(seen)).not.toContain(slug);
    }
  });
});
