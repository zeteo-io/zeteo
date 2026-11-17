// @module-tag int
// @module-tag platform
import { DATA_READ } from "../../../../../definitions/tereoDeclaration.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startV1Routes } from "../../../../support/v1App.js";
import { tokenFor } from "../../../../support/tokens.js";
import { fetchJson } from "../../../../support/http.js";
import { randomUUID } from "crypto";
import {
  clearDirectory,
  addToDirectory,
} from "../../../../support/principals.js";

const tag = randomUUID().slice(0, 8);
const ORG_A = randomUUID();
const ORG_B = randomUUID();
const GLOBAL = randomUUID();
const IN_A = randomUUID();
const IN_B = randomUUID();
const ADA = randomUUID();
const BOT = randomUUID();

describe("GET /v1/me/principals", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  const token = tokenFor({ permissions: [DATA_READ], org: ORG_A });
  const search = (query: string, t: string | null = token) =>
    fetchJson("GET", `${app.url}/v1/me/principals${query}`, t);

  beforeAll(async () => {
    app = await startV1Routes();
    await addToDirectory([
      {
        type: "group",
        id: GLOBAL,
        name: `Team global ${tag}`,
        status: "active",
      },
      {
        type: "group",
        id: IN_A,
        name: `Team a ${tag}`,
        status: "active",
        organization_id: ORG_A,
      },
      {
        type: "group",
        id: IN_B,
        name: `Team b ${tag}`,
        status: "active",
        organization_id: ORG_B,
      },
      {
        type: "user",
        id: ADA,
        name: `Ada ${tag}`,
        email: `ada-${tag}@example.test`,
        status: "active",
      },
      {
        type: "user",
        id: BOT,
        name: `Bot ${tag}`,
        status: "active",
        user_type: "service_account",
      },
    ]);
  });
  afterAll(async () => {
    await clearDirectory();
    await app.close();
  });

  it("lists global groups and the caller's organization's, not another's", async () => {
    const res = await search(`?type=group&q=${tag}`);
    expect(res.status).toBe(200);
    const ids = (res.body.data as Array<{ id: string }>).map((g) => g.id);
    expect(ids.sort()).toEqual([GLOBAL, IN_A].sort());
    expect(ids).not.toContain(IN_B);
  });

  it("lists a caller with no organization only the global groups", async () => {
    const res = await search(
      `?type=group&q=${tag}`,
      tokenFor({ permissions: [DATA_READ] })
    );
    expect(res.body.data.map((g: { id: string }) => g.id)).toEqual([GLOBAL]);
  });

  it("finds a user, and no service account", async () => {
    const res = await search(`?type=user&q=${tag}`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((u: { id: string }) => u.id)).toEqual([ADA]);
  });

  it("answers 400 to a q shorter than 2, and 403 without zeteo.data.read", async () => {
    expect((await search(`?type=user&q=a`)).status).toBe(400);
    const none = await search(
      `?type=user&q=ada`,
      tokenFor({ permissions: [] })
    );
    expect(none.status).toBe(403);
  });
});
