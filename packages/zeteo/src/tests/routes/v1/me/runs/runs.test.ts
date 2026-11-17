// @module-tag int
// @module-tag platform
import { RUNS_READ } from "../../../../../definitions/tereoDeclaration.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASE_URL, fetchJson } from "../../../../support/http.js";
import { removeSources } from "../../../../support/sources.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import { ENGINES } from "../../../../support/engines.js";
import { tokenFor } from "../../../../support/tokens.js";
import {
  savedQueryOf,
  shareDirectly,
} from "../../../../support/savedQueries.js";
import {
  grantTo,
  newQueryUser,
  postQuery,
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../../../../support/queries.js";

const myRuns = (token: string, query = "") =>
  fetchJson("GET", `${BASE_URL}/v1/me/runs${query}`, token);

describe("GET /v1/me/runs", () => {
  let source: SeededSource;
  const owner = newQueryUser();
  const recipient = newQueryUser();
  const other = newQueryUser();
  let savedId: string;

  beforeAll(async () => {
    source = await seedQuerySource(ENGINES[0]!);
    for (const u of [owner, recipient, other]) {
      await grantTo(u.principal, source.tables.orders!, ["id", "status"]);
    }
    savedId = await savedQueryOf(owner.token, source);
    await shareDirectly(savedId, recipient.principal, owner.id);
  });
  afterAll(async () => {
    await prisma.savedQueryShare.deleteMany({
      where: { savedQueryId: savedId },
    });
    await removeRunsOf([owner.id, recipient.id, other.id]);
    await prisma.savedQuery.deleteMany({ where: { id: savedId } });
    await removeSources([source.id]);
  });

  it("lists only the caller's own runs, with the query of a successful one", async () => {
    const query = { source: source.slug, from: "orders", select: ["id"] };
    expect((await postQuery(other.token, query)).status).toBe(200);
    const mine = await postQuery(owner.token, query);
    expect(mine.status).toBe(200);

    const res = await myRuns(owner.token);
    expect(res.status).toBe(200);
    const runs = res.body.data as Array<Record<string, unknown>>;
    expect(runs.map((r) => r.id)).toEqual([mine.body.run_id]);
    expect(runs[0]!.query).toEqual(query);
    expect(runs[0]).not.toHaveProperty("saved_query");
    expect(res.body.next_cursor).toBeNull();
    expect((await myRuns(owner.token, "?outcome=failed")).body.data).toEqual(
      []
    );
  });

  it("is open to a holder of only zeteo.data.read, and not to one without it", async () => {
    expect((await myRuns(other.token)).status).toBe(200);
    const none = await myRuns(tokenFor({ permissions: [RUNS_READ] }));
    expect(none.status).toBe(403);
  });

  it("attaches the saved query to a run of it the caller can see, and not once they cannot", async () => {
    const ran = await fetchJson(
      "POST",
      `${BASE_URL}/v1/saved-queries/${savedId}/run`,
      recipient.token,
      {}
    );
    expect(ran.status).toBe(200);
    const name = (
      await prisma.savedQuery.findUniqueOrThrow({ where: { id: savedId } })
    ).name;

    const seen = await myRuns(recipient.token);
    expect(seen.body.data[0].saved_query).toEqual({ id: savedId, name });

    await prisma.savedQueryShare.deleteMany({
      where: { savedQueryId: savedId },
    });
    const after = await myRuns(recipient.token);
    expect(after.body.data[0].id).toBe(seen.body.data[0].id);
    expect(after.body.data[0]).not.toHaveProperty("saved_query");
  });

  it("filters to the runs of one saved query", async () => {
    const query = { source: source.slug, from: "orders", select: ["id"] };
    expect((await postQuery(owner.token, query)).status).toBe(200);
    const ran = await fetchJson(
      "POST",
      `${BASE_URL}/v1/saved-queries/${savedId}/run`,
      owner.token,
      {}
    );
    expect(ran.status).toBe(200);

    const res = await myRuns(owner.token, `?saved_query_id=${savedId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((r: { id: string }) => r.id)).toEqual([
      ran.body.run_id,
    ]);
    // Another user's runs of it stay theirs.
    expect(
      (await myRuns(other.token, `?saved_query_id=${savedId}`)).body.data
    ).toEqual([]);
    expect((await myRuns(owner.token, "?saved_query_id=nope")).status).toBe(
      400
    );
  });

  it("pages with a cursor", async () => {
    const query = { source: source.slug, from: "orders", select: ["id"] };
    for (let i = 0; i < 2; i++) await postQuery(other.token, query);
    const first = await myRuns(other.token, "?limit=2");
    expect(first.body.data).toHaveLength(2);
    expect(first.body.next_cursor).not.toBeNull();
    const next = await myRuns(
      other.token,
      `?limit=2&cursor=${encodeURIComponent(first.body.next_cursor)}`
    );
    expect(next.body.data).toHaveLength(1);
  });
});
