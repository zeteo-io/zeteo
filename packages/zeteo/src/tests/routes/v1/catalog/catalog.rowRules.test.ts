// @module-tag int
// @module-tag platform
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASE_URL, fetchJson } from "../../../support/http.js";
import { removeSources } from "../../../support/sources.js";
import { prisma } from "../../../../utils/db/prisma.js";
import { ENGINES } from "../../../support/engines.js";
import { randomUUID } from "node:crypto";
import {
  grantTo,
  newQueryUser,
  seedQuerySource,
  type SeededSource,
} from "../../../support/queries.js";

interface Table {
  name: string;
  rows_limited: boolean;
  rows_limited_reason?: string;
}

// A caller's catalogue says which tables show them only some rows, and why,
// in words that name only columns they are granted and never their identity
// values.

describe("GET /v1/catalog: rows limited", () => {
  let source: SeededSource;
  const admin = newQueryUser();
  const paid = newQueryUser();
  const hidden = newQueryUser();
  const custom = newQueryUser();
  const identity = newQueryUser();
  const noValue = newQueryUser();
  const keyIds: string[] = [];

  const tablesOf = async (token: string): Promise<Map<string, Table>> => {
    const res = await fetchJson(
      "GET",
      `${BASE_URL}/v1/catalog?source=${source.slug}`,
      token
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const tables = res.body.sources[0].tables as Table[];
    return new Map(tables.map((t) => [t.name, t]));
  };

  beforeAll(async () => {
    source = await seedQuerySource(ENGINES[0]!, {}, "catalogrows");
    const { orders, customers } = source.tables;

    await grantTo(paid.principal, orders!, "all", {
      access: "rule",
      rule: { status: { in: ["paid", "shipped"] } },
    });
    await grantTo(paid.principal, customers!, "all");

    // The rule's column is not granted.
    await grantTo(hidden.principal, orders!, ["id", "total"], {
      access: "rule",
      rule: { status: { eq: "paid" } },
    });

    await grantTo(custom.principal, orders!, "all", {
      access: "rule",
      rule: { status: { eq: "paid" } },
      description: "Your team's orders",
    });

    const key = await prisma.identityKey.create({
      data: {
        name: `status_${randomUUID().slice(0, 8)}`,
        label: "order desk",
        createdBy: admin.id,
      },
    });
    keyIds.push(key.id);
    await prisma.identityValue.create({
      data: {
        keyId: key.id,
        userId: identity.id,
        value: "shipped",
        createdBy: admin.id,
      },
    });
    for (const user of [identity, noValue]) {
      await grantTo(user.principal, orders!, "all", {
        access: "rule",
        rule: { status: { in: { identity: key.name } } },
      });
    }
  });
  afterAll(async () => {
    await removeSources([source.id]);
    await prisma.identityValue.deleteMany({ where: { keyId: { in: keyIds } } });
    await prisma.identityKey.deleteMany({ where: { id: { in: keyIds } } });
  });

  it("marks a limited table with its reason, and an unlimited one false with none", async () => {
    const tables = await tablesOf(paid.token);
    expect(tables.get("orders")).toMatchObject({
      rows_limited: true,
      rows_limited_reason: "status is one of paid, shipped",
    });
    const customers = tables.get("customers")!;
    expect(customers.rows_limited).toBe(false);
    expect(customers).not.toHaveProperty("rows_limited_reason");
  });

  it("never names a column the caller is not granted", async () => {
    const orders = (await tablesOf(hidden.token)).get("orders")!;
    expect(orders.rows_limited).toBe(true);
    expect(orders.rows_limited_reason).toBe("some rows only");
    expect(orders.rows_limited_reason).not.toContain("status");
  });

  it("gives the grant's own description over the generated sentence", async () => {
    const orders = (await tablesOf(custom.token)).get("orders")!;
    expect(orders.rows_limited_reason).toBe("Your team's orders");
  });

  it("names an identity key by its label, never the caller's values", async () => {
    const orders = (await tablesOf(identity.token)).get("orders")!;
    expect(orders.rows_limited).toBe(true);
    expect(orders.rows_limited_reason).toBe("status is your order desk");
    expect(orders.rows_limited_reason).not.toContain("shipped");
  });

  it("says no rows when the caller holds no value for the rule's key", async () => {
    const orders = (await tablesOf(noValue.token)).get("orders")!;
    expect(orders).toMatchObject({
      rows_limited: true,
      rows_limited_reason: "no rows",
    });
  });
});
