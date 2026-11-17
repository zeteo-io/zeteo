// @module-tag int
// @module-tag platform
// @module-tag security
import { SavedQueryNotAccessibleError } from "../../utils/errors.js";
import { describeEachEngine } from "../support/engines.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Caller } from "../../middleware/auth.js";
import { removeSources } from "../support/sources.js";
import { planSaved } from "../../engine/savedPlan.js";
import { loadAccess } from "../../grants/access.js";
import { prisma } from "../../utils/db/prisma.js";
import { startV1App } from "../support/v1App.js";
import { fetchJson } from "../support/http.js";
import { Router } from "express";
import {
  grantTo,
  newQueryUser,
  seedQuerySource,
  type SeededSource,
} from "../support/queries.js";

// Six causes of "no access" to a saved query (Review Focus #2), and a body
// the source's language refuses. Each must fail with the same error and the
// same response body, naming nothing from the source.

const callerOf = (userId: string): Caller => ({
  userId,
  organizationId: null,
  permissions: [],
  isServiceAccount: false,
});

const failureOf = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error("the saved query planned");
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describeEachEngine("planSaved: leaks", (engine) => {
  let source: SeededSource;
  let names: string[];
  let respond: (err: Error) => Promise<Record<string, unknown>>;
  let close: () => Promise<void>;
  let pending: Error | undefined;

  const savedQuery = () => ({
    sourceId: source.id,
    query: {
      source: source.slug,
      from: "orders",
      join: ["customers"],
      select: ["id", "status", "customers.name"],
    },
  });

  /** A new user with these grants, by table name: every column, or these. */
  const userWith = async (grants: Record<string, string[] | "all">) => {
    const user = newQueryUser();
    for (const [table, columns] of Object.entries(grants)) {
      await grantTo(user.principal, source.tables[table]!, columns);
    }
    return user;
  };

  const fullGrants = { orders: "all", customers: "all" } as const;

  const refusal = async (
    userId: string,
    query: unknown = savedQuery().query
  ): Promise<Error> => {
    const access = await loadAccess(callerOf(userId));
    const progress = { sourceId: null, unrecorded: false };
    return failureOf(
      planSaved(
        access,
        { sourceId: source.id, query: query as never },
        progress
      )
    );
  };

  beforeAll(async () => {
    source = await seedQuerySource(engine, {}, "savedleak");
    const tables = await prisma.sourceTable.findMany({
      where: { sourceId: source.id },
      include: { columns: true },
    });
    names = [
      source.slug,
      source.id,
      ...tables.flatMap((t) => [t.name, ...t.columns.map((c) => c.name)]),
    ];
    const router = Router();
    router.get("/fail", (_req, _res, next) => next(pending));
    const app = await startV1App(router);
    close = app.close;
    respond = async (err) => {
      pending = err;
      const res = await fetchJson("GET", `${app.url}/v1/fail`, null);
      return { status: res.status, ...res.body };
    };
  });
  afterAll(async () => {
    await close();
    await removeSources([source.id]);
  });

  it("plans the saved query for a viewer holding every name it uses", async () => {
    const user = await userWith(fullGrants);
    const access = await loadAccess(callerOf(user.id));
    const planned = await planSaved(access, savedQuery(), {
      sourceId: null,
      unrecorded: false,
    });
    expect(planned.plan.columns.map((c) => c.name)).toEqual([
      "id",
      "status",
      "customers.name",
    ]);
  });

  it("fails every cause with one error and one body that names nothing", async () => {
    const causes: Record<string, () => Promise<Error>> = {
      "an ungranted column": async () =>
        refusal(
          (
            await userWith({
              orders: ["id", "customer_id"],
              customers: "all",
            })
          ).id
        ),
      "an ungranted table": async () =>
        refusal((await userWith({ orders: "all" })).id),
      "a relation not visible": async () =>
        refusal(
          (await userWith({ orders: "all", customers: ["name", "region"] })).id
        ),
      "an archived source": async () => {
        const user = await userWith(fullGrants);
        await prisma.source.update({
          where: { id: source.id },
          data: { archivedAt: new Date() },
        });
        try {
          return await refusal(user.id);
        } finally {
          await prisma.source.update({
            where: { id: source.id },
            data: { archivedAt: null },
          });
        }
      },
      "a source with no grant at all": async () => refusal(newQueryUser().id),
      "a column now missing": async () => {
        const user = await userWith(fullGrants);
        const status = source.tables.orders!.columns.status!;
        await prisma.sourceColumn.update({
          where: { id: status },
          data: { missingSince: new Date() },
        });
        try {
          return await refusal(user.id);
        } finally {
          await prisma.sourceColumn.update({
            where: { id: status },
            data: { missingSince: null },
          });
        }
      },
      "a body the language refuses": async () =>
        refusal((await userWith(fullGrants)).id, {
          ...savedQuery().query,
          zzqxw: true,
        }),
    };

    const bodies: Record<string, unknown> = {};
    for (const [cause, run] of Object.entries(causes)) {
      const err = await run();
      expect(err, cause).toBeInstanceOf(SavedQueryNotAccessibleError);
      expect(err.cause, cause).toBeUndefined();
      expect((err as SavedQueryNotAccessibleError).details, cause).toBe(
        undefined
      );
      const body = await respond(err);
      // Values only: keys such as `name` are the error's own, not the source's.
      const seen = [
        JSON.stringify(Object.values(body)),
        JSON.stringify(Object.values({ ...err })),
        err.message,
      ];
      for (const name of names) {
        const word = new RegExp(`\\b${escape(name)}\\b`);
        for (const text of seen)
          expect(text, `${cause}: ${name}`).not.toMatch(word);
      }
      bodies[cause] = body;
    }

    for (const body of Object.values(bodies)) {
      expect(body).toEqual({
        status: 403,
        error: "saved_query_not_accessible",
        error_description:
          "You need expanded permissions to run this saved query. Ask an admin to extend your access.",
      });
    }
  });
});
