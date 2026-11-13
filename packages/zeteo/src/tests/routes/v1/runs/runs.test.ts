// @module-tag int
// @module-tag platform
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASE_URL, fetchJson } from "../../../support/http.js";
import { removeSources } from "../../../support/sources.js";
import { ENGINES } from "../../../support/engines.js";
import { tokenFor } from "../../../support/tokens.js";
import { randomUUID } from "crypto";
import {
  DATA_READ,
  RUNS_READ,
} from "../../../../definitions/tereoDeclaration.js";
import {
  grantTo,
  newQueryUser,
  postQuery,
  removeRunsOf,
  runsOf,
  seedQuerySource,
  type SeededSource,
} from "../../../support/queries.js";

const runsToken = () => tokenFor({ permissions: [RUNS_READ] });

const list = (query: Record<string, string> = {}, token = runsToken()) =>
  fetchJson(
    "GET",
    `${BASE_URL}/v1/runs?${new URLSearchParams(query).toString()}`,
    token
  );

describe("GET /v1/runs", () => {
  let source: SeededSource;
  const user = newQueryUser();
  const other = newQueryUser();
  /** Run ids in the order they were made. */
  const made: string[] = [];
  let refusedOther: string;

  beforeAll(async () => {
    source = await seedQuerySource(ENGINES[0]!);
    await grantTo(user.principal, source.tables.accounts!, "all");
    await grantTo(other.principal, source.tables.accounts!, "all");
    for (let i = 0; i < 3; i++) {
      const res = await postQuery(user.token, {
        source: source.slug,
        from: "accounts",
        select: ["id"],
      });
      expect(res.status).toBe(200);
      made.push(res.body.run_id as string);
    }
    expect(
      (
        await postQuery(other.token, {
          source: source.slug,
          from: "accounts",
          select: ["nope"],
        })
      ).status
    ).toBe(422);
    const [run] = await runsOf([other.id]);
    refusedOther = run!.id;
  });
  afterAll(async () => {
    await removeRunsOf([user.id, other.id]);
    await removeSources([source.id]);
  });

  it("lists a user's runs newest first, as views", async () => {
    const res = await list({ user_id: user.id });
    expect(res.status).toBe(200);
    expect(res.body.data.map((r: { id: string }) => r.id)).toEqual(
      [...made].reverse()
    );
    expect(res.body.next_cursor).toBeNull();
    expect(res.body.data[0]).toEqual({
      id: made[2],
      user_id: user.id,
      source_id: source.id,
      entry_point: "api",
      query: { source: source.slug, from: "accounts", select: ["id"] },
      duration_ms: expect.any(Number),
      row_count: 2,
      outcome: "ok",
      error_code: null,
      truncated: false,
      created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
    });
  });

  it("pages with a cursor", async () => {
    const first = await list({ user_id: user.id, limit: "2" });
    expect(first.body.data.map((r: { id: string }) => r.id)).toEqual([
      made[2],
      made[1],
    ]);
    expect(first.body.next_cursor).toEqual(expect.any(String));
    const second = await list({
      user_id: user.id,
      limit: "2",
      cursor: first.body.next_cursor,
    });
    expect(second.body.data.map((r: { id: string }) => r.id)).toEqual([
      made[0],
    ]);
    expect(second.body.next_cursor).toBeNull();
  });

  it("filters by source and outcome", async () => {
    const bySource = await list({ source_id: source.id });
    expect(bySource.body.data.map((r: { id: string }) => r.id)).toEqual([
      refusedOther,
      ...[...made].reverse(),
    ]);
    const refused = await list({ source_id: source.id, outcome: "refused" });
    expect(refused.body.data).toEqual([
      expect.objectContaining({
        id: refusedOther,
        user_id: other.id,
        outcome: "refused",
        error_code: "not_found_or_not_accessible",
        row_count: null,
      }),
    ]);
    expect((await list({ user_id: randomUUID() })).body.data).toEqual([]);
  });

  it("refuses a bad filter or cursor with 400 invalid_request", async () => {
    const bad: Record<string, string>[] = [
      { outcome: "maybe" },
      { user_id: "not-a-uuid" },
      { cursor: "!!" },
      { limit: "0" },
    ];
    for (const query of bad) {
      const res = await list(query);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request");
    }
  });

  it("needs zeteo.runs.read", async () => {
    expect(
      (await list({}, tokenFor({ permissions: [DATA_READ] }))).status
    ).toBe(403);
    expect((await list({}, tokenFor({ permissions: [] }))).status).toBe(403);
    const res = await fetchJson("GET", `${BASE_URL}/v1/runs`, null);
    expect(res.status).toBe(401);
  });
});
