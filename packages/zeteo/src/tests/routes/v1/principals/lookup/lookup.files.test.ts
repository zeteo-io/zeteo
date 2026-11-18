// @module-tag int
// @module-tag platform
// @module-tag security
import { SEARCH_LIMIT_PER_MINUTE } from "../../../../../principals/searchRateLimit.js";
import type { Principal } from "../../../../../principals/directory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startV1Routes } from "../../../../support/v1App.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import { tokenFor } from "../../../../support/tokens.js";
import { fetchJson } from "../../../../support/http.js";
import { randomUUID } from "crypto";
import {
  DATA_READ,
  UPLOADS_WRITE,
  GRANTS_READ,
} from "../../../../../definitions/tereoDeclaration.js";
import {
  clearDirectory,
  seedDirectory,
} from "../../../../support/principals.js";
import {
  removeUploadSources,
  seedUploadSource,
} from "../../../../support/uploads.js";

const tag = randomUUID().slice(0, 8);
const ownerId = randomUUID();
const ADA = randomUUID();
const TEAM = randomUUID();
const BOB = randomUUID();
const GONE = randomUUID();

const seeded: Principal[] = [
  {
    type: "user",
    id: ADA,
    name: `Ada ${tag}`,
    email: `ada-${tag}@example.test`,
    status: "active",
  },
  { type: "group", id: TEAM, name: `Team ${tag}`, status: "active" },
  {
    type: "user",
    id: BOB,
    name: `Bob ${tag}`,
    email: `bob-${tag}@example.test`,
    status: "active",
  },
];

const TABLE = {
  name: "people",
  columns: [{ name: "id", type: "number" as const }],
  rows: [["1"]],
};

const ownerToken = () =>
  tokenFor({ userId: ownerId, permissions: [DATA_READ, UPLOADS_WRITE] });

describe("POST /v1/principals/lookup for an upload source owner", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  const sources: string[] = [];

  const lookup = (refs: { type: string; id: string }[], token: string) =>
    fetchJson("POST", `${app.url}/v1/principals/lookup`, token, {
      principals: refs,
    });

  beforeAll(async () => {
    app = await startV1Routes();
    await seedDirectory(seeded);
    // Ada and the team hold grants on the owner's source; Bob only on
    // another owner's.
    const own = await seedUploadSource({ ownerId, tables: [TABLE] });
    const others = await seedUploadSource({
      ownerId: randomUUID(),
      tables: [TABLE],
    });
    sources.push(own.id, others.id);
    await prisma.grant.createMany({
      data: [
        { principalType: "user" as const, principalId: ADA, s: own },
        { principalType: "group" as const, principalId: TEAM, s: own },
        { principalType: "user" as const, principalId: BOB, s: others },
      ].map(({ s, ...g }) => ({
        ...g,
        tableId: s.tables.people!.id,
        allColumns: true,
        createdBy: ownerId,
      })),
    });
  });
  afterAll(async () => {
    await removeUploadSources(sources);
    await clearDirectory();
    await app.close();
  });

  it("names the people and groups their sources are shared with", async () => {
    const res = await lookup(
      [
        { type: "user", id: ADA },
        { type: "group", id: TEAM },
      ],
      ownerToken()
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([seeded[0], seeded[1]]);
  });

  it("answers any other id as an unknown one, in order, with no hint", async () => {
    const res = await lookup(
      [
        { type: "user", id: BOB },
        { type: "user", id: ADA },
        { type: "user", id: GONE },
        { type: "group", id: randomUUID() },
      ],
      ownerToken()
    );
    expect(res.status).toBe(200);
    const [bob, ada, gone, group] = res.body.data;
    expect(ada).toEqual(seeded[0]);
    // Bob is known to tereo, yet answered exactly as an id it does not know.
    expect(bob).toEqual({ ...gone, id: BOB });
    expect(gone).toEqual({
      type: "user",
      id: GONE,
      name: null,
      email: null,
      status: "orphaned",
    });
    expect(group).toMatchObject({
      type: "group",
      name: null,
      status: "orphaned",
    });
  });

  it("leaves an admin's lookup unchanged", async () => {
    const res = await lookup(
      [{ type: "user", id: BOB }],
      tokenFor({ permissions: [GRANTS_READ] })
    );
    expect(res.body.data).toEqual([seeded[2]]);
  });

  it("counts an owner's lookups against the search rate limit", async () => {
    const token = tokenFor({
      userId: randomUUID(),
      permissions: [DATA_READ, UPLOADS_WRITE],
    });
    for (let i = 0; i < SEARCH_LIMIT_PER_MINUTE; i++) {
      expect((await lookup([{ type: "user", id: ADA }], token)).status).toBe(
        200
      );
    }
    const res = await lookup([{ type: "user", id: ADA }], token);
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("too_many_requests");
  });
});
