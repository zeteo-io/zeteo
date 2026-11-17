// @module-tag int
// @module-tag platform
import type { SavedQuery } from "../../../prisma/generated/client/index.js";
import { loadSourceVisibleCatalog } from "../../grants/visibleCatalog.js";
import { canUse, decideAccess } from "../../saved-queries/access.js";
import type { Caller } from "../../middleware/auth.js";
import { removeSources } from "../support/sources.js";
import { db, prisma } from "../../utils/db/index.js";
import { loadAccess } from "../../grants/access.js";
import { ENGINES } from "../support/engines.js";
import { randomUUID } from "crypto";
import {
  grantTo,
  newQueryUser,
  removeGrant,
  seedQuerySource,
  type SeededSource,
} from "../support/queries.js";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const callerOf = (userId: string): Caller => ({
  userId,
  organizationId: null,
  permissions: [],
  isServiceAccount: false,
});

describe("saved query access", () => {
  let source: SeededSource;
  let other: SeededSource;

  const queryOn = (on: SeededSource, select = ["id", "status"]) => ({
    sourceId: on.id,
    query: { source: on.slug, from: "orders", select },
  });

  const savedRow = (on: SeededSource, select?: string[]): SavedQuery => ({
    id: randomUUID(),
    ownerId: randomUUID(),
    name: "q",
    description: "",
    lastRunAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...queryOn(on, select),
  });

  const usable = async (userId: string, on = source) => {
    const access = await loadAccess(callerOf(userId));
    const catalog = await loadSourceVisibleCatalog(on.id, access);
    return canUse(access, queryOn(on), catalog);
  };

  beforeAll(async () => {
    source = await seedQuerySource(ENGINES[0]!, {}, "savedaccess");
    other = await seedQuerySource(ENGINES[0]!, {}, "savedother");
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => removeSources([source.id, other.id]));

  describe("canUse", () => {
    it("is true for a user granted every column the saved query uses", async () => {
      const user = newQueryUser();
      await grantTo(user.principal, source.tables.orders!, ["id", "status"]);
      expect(await usable(user.id)).toBe(true);
    });

    it("is false once one of those columns is no longer granted", async () => {
      const user = newQueryUser();
      const grant = await grantTo(user.principal, source.tables.orders!, [
        "id",
        "status",
      ]);
      expect(await usable(user.id)).toBe(true);
      await removeGrant(grant);
      await grantTo(user.principal, source.tables.orders!, ["id"]);
      expect(await usable(user.id)).toBe(false);
    });

    it("is false once the source is archived", async () => {
      const user = newQueryUser();
      await grantTo(user.principal, source.tables.orders!, "all");
      const access = await loadAccess(callerOf(user.id));
      await prisma.source.update({
        where: { id: source.id },
        data: { archivedAt: new Date() },
      });
      try {
        const catalog = await loadSourceVisibleCatalog(source.id, access);
        expect(canUse(access, queryOn(source), catalog)).toBe(false);
      } finally {
        await prisma.source.update({
          where: { id: source.id },
          data: { archivedAt: null },
        });
      }
    });

    it("is false for a catalogue of another source", async () => {
      const user = newQueryUser();
      await grantTo(user.principal, source.tables.orders!, "all");
      await grantTo(user.principal, other.tables.orders!, "all");
      const access = await loadAccess(callerOf(user.id));
      const catalog = await loadSourceVisibleCatalog(other.id, access);
      expect(canUse(access, queryOn(source), catalog)).toBe(false);
    });
  });

  describe("decideAccess", () => {
    it("loads each source's catalogue once and decides every saved query", async () => {
      const user = newQueryUser();
      await grantTo(user.principal, source.tables.orders!, ["id", "status"]);
      const access = await loadAccess(callerOf(user.id));
      const usableOne = savedRow(source);
      const ungranted = savedRow(source, ["id", "total"]);
      const hidden = savedRow(other);
      const load = vi.spyOn(db.catalog, "loadSourceCatalog");

      const decided = await decideAccess(access, [
        usableOne,
        ungranted,
        hidden,
      ]);

      expect(load).toHaveBeenCalledTimes(2);
      expect(new Set(load.mock.calls.map(([id]) => id))).toEqual(
        new Set([source.id, other.id])
      );
      expect(decided).toEqual(
        new Map([
          [usableOne.id, true],
          [ungranted.id, false],
          [hidden.id, false],
        ])
      );
    });

    it("answers an empty map for no saved queries", async () => {
      const access = await loadAccess(callerOf(newQueryUser().id));
      expect(await decideAccess(access, [])).toEqual(new Map());
    });
  });
});
