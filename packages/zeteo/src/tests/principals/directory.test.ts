// @module-tag int
// @module-tag platform
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import {
  lookupPrincipals,
  searchPrincipals,
  type Principal,
} from "../../principals/directory.js";
import {
  clearOrphaned,
  clearDirectory,
  markOrphaned,
  seedDirectory,
} from "../support/principals.js";

const user = (
  name: string,
  email: string,
  status: Principal["status"] = "active"
): Principal => ({
  type: "user",
  id: randomUUID(),
  name,
  email,
  status,
});
const group = (name: string): Principal => ({
  type: "group",
  id: randomUUID(),
  name,
  status: "active",
});

const ada = user("Ada Lovelace", "ada@Example.com");
const adam = user("Adam", "adam@example.com");
const grace = user("Grace", "GRACE@example.com");
const analysts = group("Analysts");
const orphanId = randomUUID();

beforeEach(() => seedDirectory([ada, adam, grace, analysts]));
afterEach(async () => {
  await clearDirectory();
  await clearOrphaned(orphanId);
});

describe("searchPrincipals in test mode", () => {
  it("matches name and email case-insensitively and honours limit", async () => {
    expect(
      (await searchPrincipals("user", "LOVELACE", 10)).map((p) => p.id)
    ).toEqual([ada.id]);
    expect(
      (await searchPrincipals("user", "grace@EXAMPLE", 10)).map((p) => p.id)
    ).toEqual([grace.id]);
    expect(await searchPrincipals("user", "ada", 10)).toHaveLength(2);
    expect(await searchPrincipals("user", "ada", 1)).toHaveLength(1);
    expect(await searchPrincipals("user", "analy", 10)).toEqual([]);
    expect(await searchPrincipals("group", "ANALY", 10)).toEqual([analysts]);
  });
});

describe("lookupPrincipals in test mode", () => {
  it("returns the seeded entry, and an unseeded id is orphaned", async () => {
    const missing = randomUUID();
    expect(
      await lookupPrincipals([
        { type: "user", id: adam.id },
        { type: "user", id: missing },
        { type: "group", id: analysts.id },
      ])
    ).toEqual([
      adam,
      {
        type: "user",
        id: missing,
        name: null,
        email: null,
        status: "orphaned",
      },
      analysts,
    ]);
  });

  it("honours the orphaned marker over a seeded entry", async () => {
    await seedDirectory([{ ...ada, id: orphanId }]);
    await markOrphaned(orphanId);
    const [p] = await lookupPrincipals([{ type: "user", id: orphanId }]);
    expect(p!.status).toBe("orphaned");
    expect(p!.name).toBeNull();
  });
});
