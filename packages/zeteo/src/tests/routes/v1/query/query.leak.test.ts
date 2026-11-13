// @module-tag int
// @module-tag platform
import { clearTestGroups, setTestGroups } from "../../../support/principals.js";
import { describeEachEngine } from "../../../support/engines.js";
import type { JsonResponse } from "../../../support/http.js";
import { removeSources } from "../../../support/sources.js";
import { startV1Routes } from "../../../support/v1App.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { prisma } from "../../../../utils/db/prisma.js";
import { randomUUID } from "crypto";
import {
  closeAllSourcePools,
  isSourcePoolOpen,
} from "../../../../sources/pools.js";
import {
  grantTo,
  newQueryUser,
  postQuery,
  removeGrant,
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../../../support/queries.js";

// A caller holds two columns of `orders` (id and status). Everything else
// must fail exactly as a name that does not exist: same status, code,
// message (but for the name), path and suggestions.

const UNGRANTED_COLUMNS = [
  "customer_id",
  "total",
  "created_at",
  "notes",
  "external_ref",
];
/** Not a column of any fixture table, and far from every name in it. */
const INVENTED = "zzqxw";

/** Each place a column can be named, as a query over `orders`. */
const POSITIONS: Array<[string, (column: string) => Record<string, unknown>]> =
  [
    ["select", (c) => ({ select: ["id", c] })],
    ["an aggregate", (c) => ({ select: [{ max: c }] })],
    ["a bucket", (c) => ({ select: [{ bucket: "day", column: c }] })],
    ["where", (c) => ({ select: ["id"], where: { [c]: { isNull: true } } })],
    [
      "a nested where",
      (c) => ({
        select: ["id"],
        where: { or: [{ id: { eq: 1 } }, { not: { [c]: { isNull: true } } }] },
      }),
    ],
    ["orderBy", (c) => ({ select: ["id"], orderBy: [{ [c]: "asc" }] })],
    ["groupBy", (c) => ({ select: ["id"], groupBy: [c] })],
  ];

/**
 * The parts of an error a caller can compare, with the name it echoes (in the
 * message, or as a key in the path) replaced, and the request id, which
 * differs for every request, normalised.
 */
const shapeOf = (res: JsonResponse, name: string) => ({
  status: res.status,
  body: {
    ...res.body,
    request_id:
      typeof res.body?.request_id === "string"
        ? "<request id>"
        : res.body?.request_id,
    error_description:
      typeof res.body?.error_description === "string"
        ? res.body.error_description.replaceAll(name, "<name>")
        : res.body?.error_description,
    path: Array.isArray(res.body?.path)
      ? res.body.path.map((p: unknown) => (p === name ? "<name>" : p))
      : res.body?.path,
  },
});

describeEachEngine("POST /v1/query: leaks", (engine) => {
  let source: SeededSource;
  let other: SeededSource;
  const user = newQueryUser();
  const users = [user.id];

  const query = (body: Record<string, unknown>, as = user.token) =>
    postQuery(as, { source: source.slug, from: "orders", ...body });

  beforeAll(async () => {
    source = await seedQuerySource(engine);
    other = await seedQuerySource(engine, {}, "nogrant");
    await grantTo(user.principal, source.tables.orders!, ["id", "status"]);
  });
  afterAll(async () => {
    await removeRunsOf(users);
    await removeSources([source.id, other.id]);
  });

  it("answers the granted columns", async () => {
    const res = await query({
      select: ["id", "status"],
      where: { id: { eq: 4 } },
    });
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([[4, "paid"]]);
  });

  for (const [position, build] of POSITIONS) {
    it.each(UNGRANTED_COLUMNS)(
      `refuses ungranted %s in ${position} exactly as an invented name`,
      async (column) => {
        const ungranted = await query(build(column));
        const invented = await query(build(INVENTED));
        expect(ungranted.status).not.toBe(200);
        expect(shapeOf(ungranted, column)).toEqual(shapeOf(invented, INVENTED));
      }
    );
  }

  it("refuses an ungranted column with not_found_or_not_accessible and the column's path", async () => {
    const res = await query({ select: ["id", "total"] });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      error: "not_found_or_not_accessible",
      error_description: 'Column "total" was not found or is not accessible',
      path: ["select", 1],
      suggestions: [],
      request_id: expect.any(String),
    });
  });

  it("suggests only names the caller can see", async () => {
    const near = await query({ select: ["statu"] });
    expect(near.status).toBe(422);
    expect(near.body.suggestions).toEqual(["status"]);
    // `total` exists, ungranted: it is never suggested.
    const hidden = await query({ select: ["tota"] });
    expect(hidden.status).toBe(422);
    expect(hidden.body.suggestions).toEqual([]);
  });

  it("refuses an ungranted table exactly as an invented one", async () => {
    const ungranted = await query({ from: "customers", select: ["id"] });
    const invented = await query({ from: "zzqxwtable", select: ["id"] });
    expect(ungranted.status).toBe(422);
    expect(ungranted.body.error).toBe("not_found_or_not_accessible");
    expect(shapeOf(ungranted, "customers")).toEqual(
      shapeOf(invented, "zzqxwtable")
    );
  });

  it("refuses a relation whose key is ungranted exactly as an invented one", async () => {
    // The relation `customer` is keyed on orders.customer_id, not granted.
    const ungranted = await query({ join: ["customer"], select: ["id"] });
    const invented = await query({ join: ["zzqxwrel"], select: ["id"] });
    expect(ungranted.status).toBe(422);
    expect(ungranted.body.error).toBe("not_found_or_not_accessible");
    expect(shapeOf(ungranted, "customer")).toEqual(
      shapeOf(invented, "zzqxwrel")
    );
  });

  it("refuses a source without grants exactly as an unknown one, at path source", async () => {
    const body = { from: "orders", select: ["id"] };
    const ungranted = await postQuery(user.token, {
      source: other.slug,
      ...body,
    });
    const unknown = await postQuery(user.token, {
      source: "invented-zzqxw",
      ...body,
    });
    expect(ungranted.status).toBe(422);
    expect(ungranted.body).toEqual({
      error: "not_found_or_not_accessible",
      error_description: `Source "${other.slug}" was not found or is not accessible`,
      path: ["source"],
      suggestions: [],
      request_id: expect.any(String),
    });
    expect(shapeOf(ungranted, other.slug)).toEqual(
      shapeOf(unknown, "invented-zzqxw")
    );
  });

  it("answers a malformed query against an invisible source not_found_or_not_accessible, not a validation error", async () => {
    for (const slug of [other.slug, "invented-zzqxw"]) {
      const res = await postQuery(user.token, {
        source: slug,
        from: 7,
        select: "nothing",
        bogus: true,
      });
      expect(res.status).toBe(422);
      expect(res.body.error).toBe("not_found_or_not_accessible");
      expect(res.body.path).toEqual(["source"]);
    }
  });

  it("counts a group's grant while the caller is in the group, and stops when they leave", async () => {
    const member = newQueryUser();
    users.push(member.id);
    const groupId = randomUUID();
    await grantTo(
      { type: "group", id: groupId },
      source.tables.customers!,
      "all"
    );
    const body = { from: "customers", select: ["id"] };

    await setTestGroups(member.id, [{ id: groupId, organizationId: null }]);
    const inGroup = await query(body, member.token);
    expect(inGroup.status).toBe(200);
    expect(inGroup.body.rows).toEqual([[1], [2], [3]]);

    await setTestGroups(member.id, []);
    const left = await query(body, member.token);
    expect(left.status).toBe(422);
    expect(left.body.error).toBe("not_found_or_not_accessible");
    await clearTestGroups(member.id);
  });

  it("stops answering on the next request once the grant is removed", async () => {
    const holder = newQueryUser();
    users.push(holder.id);
    const grantId = await grantTo(holder.principal, source.tables.accounts!, [
      "id",
    ]);
    const body = { from: "accounts", select: ["id"] };
    expect((await query(body, holder.token)).status).toBe(200);
    await removeGrant(grantId);
    const after = await query(body, holder.token);
    expect(after.status).toBe(422);
    expect(after.body.error).toBe("not_found_or_not_accessible");
    expect(after.body.path).toEqual(["source"]);
  });

  it("refuses a column marked missing with missing_in_source and never reaches the source", async () => {
    // A source of its own, queried through routes in this process: its pool
    // here opens only when a query reaches the source.
    const fresh = await seedQuerySource(engine);
    const app = await startV1Routes();
    const reader = newQueryUser();
    users.push(reader.id);
    try {
      const accounts = fresh.tables.accounts!;
      await grantTo(reader.principal, accounts, "all");
      await prisma.sourceColumn.update({
        where: { id: accounts.columns.plan },
        data: { missingSince: new Date() },
      });
      const body = { source: fresh.slug, from: "accounts" };

      const missing = await postQuery(
        reader.token,
        { ...body, select: ["id", "plan"] },
        app.url
      );
      expect(missing.status).toBe(422);
      expect(missing.body).toEqual({
        error: "missing_in_source",
        error_description: 'Column "plan" is missing from the source',
        path: ["select", 1],
        suggestions: [],
      });
      expect(isSourcePoolOpen(fresh.id)).toBe(false);

      // The same check sees a query that does reach the source.
      const ok = await postQuery(
        reader.token,
        { ...body, select: ["id"] },
        app.url
      );
      expect(ok.status).toBe(200);
      expect(isSourcePoolOpen(fresh.id)).toBe(true);
    } finally {
      await closeAllSourcePools();
      await app.close();
      await removeRunsOf([reader.id]);
      await removeSources([fresh.id]);
    }
  });
});
