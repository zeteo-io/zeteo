import { createSavedQuery, shareDirectly, uniqueName } from "./savedQueries.js";
import { removeSources, writeToken } from "./sources.js";
import { prisma } from "../../utils/db/prisma.js";
import { BASE_URL, fetchJson } from "./http.js";
import { ENGINES } from "./engines.js";
import {
  grantTo,
  newQueryUser,
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "./queries.js";

// The six causes of "no access" to a saved query shared with a recipient, set
// up the same way for every test of them: an ungranted column, an ungranted
// table, a relation not visible, an archived source, no grant at all, and a
// column now missing.

export const CAUSE_QUERY_COLUMNS = ["id", "status", "customers.region"];

/** The one query every case saves: orders joined to customers. */
export const causeQueryOn = (on: SeededSource) => ({
  source: on.slug,
  from: "orders",
  join: ["customers"],
  select: CAUSE_QUERY_COLUMNS,
});

export interface CauseSources {
  /** The live source of the first three causes and of "no grant at all". */
  source: SeededSource;
  /** Archived once the saved query on it is shared. */
  archived: SeededSource;
  /** `orders.status` is marked missing once the saved query on it is shared. */
  missing: SeededSource;
}

/** A user as `newQueryUser` and `newExportUser` make them. */
export type Recipient = {
  id: string;
  token: string;
  principal: { type: "user"; id: string };
};

export interface NoAccessCase {
  cause: string;
  on: SeededSource;
  recipient: Recipient;
  /** The saved query shared with the recipient. */
  id: string;
}

/**
 * Seeds the three sources (`fields` on each) and an owner granted all of
 * `orders` and `customers` on each, so the owner is the same in every case.
 */
export const seedCauseSources = async (
  fields: Record<string, unknown> = {},
  slugPrefix = "leak",
  owner: Recipient = newQueryUser()
): Promise<CauseSources & { owner: Recipient }> => {
  const sources: CauseSources = {
    source: await seedQuerySource(ENGINES[0]!, fields, `${slugPrefix}a`),
    archived: await seedQuerySource(ENGINES[0]!, fields, `${slugPrefix}b`),
    missing: await seedQuerySource(ENGINES[0]!, fields, `${slugPrefix}c`),
  };
  for (const on of Object.values(sources)) {
    for (const table of ["orders", "customers"]) {
      await grantTo(owner.principal, on.tables[table]!, "all");
    }
  }
  return { ...sources, owner };
};

/**
 * One recipient per cause (made by `newRecipient`), each with a saved query
 * of `owner`'s shared with them; then the archived source is archived and the
 * missing column marked missing.
 */
export const setUpNoAccessCases = async (
  { source, archived, missing }: CauseSources,
  owner: Recipient,
  newRecipient: () => Recipient = newQueryUser
): Promise<NoAccessCase[]> => {
  // 1. an ungranted column
  const column = newRecipient();
  await grantTo(column.principal, source.tables.orders!, ["id"]);
  await grantTo(column.principal, source.tables.customers!, "all");
  // 2. an ungranted table
  const table = newRecipient();
  await grantTo(table.principal, source.tables.customers!, "all");
  // 3. a relation not visible: the key column of customers is not granted
  const relation = newRecipient();
  await grantTo(relation.principal, source.tables.orders!, "all");
  await grantTo(relation.principal, source.tables.customers!, ["region"]);
  // 4. an archived source, 6. a column now missing: granted everything
  const arch = newRecipient();
  const gone = newRecipient();
  for (const [who, on] of [
    [arch, archived],
    [gone, missing],
  ] as const) {
    for (const t of ["orders", "customers"]) {
      await grantTo(who.principal, on.tables[t]!, "all");
    }
  }
  // 5. no grant at all
  const none = newRecipient();

  const planned: Array<[string, SeededSource, Recipient]> = [
    ["an ungranted column", source, column],
    ["an ungranted table", source, table],
    ["a relation not visible", source, relation],
    ["an archived source", archived, arch],
    ["no grant at all", source, none],
    ["a missing column", missing, gone],
  ];
  const cases: NoAccessCase[] = [];
  for (const [cause, on, recipient] of planned) {
    const made = await createSavedQuery(owner.token, {
      name: uniqueName(),
      query: causeQueryOn(on),
    });
    if (made.status !== 201) {
      throw new Error(`saved query not created: ${made.status}`);
    }
    await shareDirectly(
      made.body.id,
      { type: "user", id: recipient.id },
      owner.id
    );
    cases.push({ cause, on, recipient, id: made.body.id as string });
  }

  const archive = await fetchJson(
    "POST",
    `${BASE_URL}/v1/sources/${archived.id}/archive`,
    writeToken()
  );
  if (archive.status !== 204) {
    throw new Error(`source not archived: ${archive.status}`);
  }
  await prisma.sourceColumn.updateMany({
    where: { tableId: missing.tables.orders!.id, name: "status" },
    data: { missingSince: new Date() },
  });
  return cases;
};

/** Removes the cases' runs, the owner's, and the three sources. */
export const removeNoAccessCases = async (
  sources: CauseSources,
  userIds: string[]
): Promise<void> => {
  await removeRunsOf(userIds);
  await removeSources([
    sources.source.id,
    sources.archived.id,
    sources.missing.id,
  ]);
};
