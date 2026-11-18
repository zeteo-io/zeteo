// @module-tag int
// @module-tag platform
import { DATA_READ } from "../../../../../../definitions/tereoDeclaration.js";
import type { Principal } from "../../../../../../principals/directory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startV1Routes } from "../../../../../support/v1App.js";
import { tokenFor } from "../../../../../support/tokens.js";
import { fetchJson } from "../../../../../support/http.js";
import { randomUUID } from "crypto";
import {
  clearDirectory,
  addToDirectory,
} from "../../../../../support/principals.js";

const tag = randomUUID().slice(0, 8);
const ORG_A = randomUUID();
const ORG_B = randomUUID();
const GLOBAL = randomUUID();
const IN_A = randomUUID();
const IN_B = randomUUID();
const ADA = randomUUID();
const BOT = randomUUID();

describe("GET /v1/me/principals/all", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  const token = tokenFor({ permissions: [DATA_READ], org: ORG_A });
  const list = (t: string | null = token, query = "") =>
    fetchJson("GET", `${app.url}/v1/me/principals/all${query}`, t);
  const ours = (data: Principal[]) =>
    data
      .map((p) => p.id)
      .filter((id) => new Set<string>([GLOBAL, IN_A, IN_B, ADA, BOT]).has(id));

  beforeAll(async () => {
    app = await startV1Routes();
    await addToDirectory([
      { type: "group", id: GLOBAL, name: `b ${tag}`, status: "active" },
      {
        type: "group",
        id: IN_A,
        name: `c ${tag}`,
        status: "active",
        organization_id: ORG_A,
      },
      {
        type: "group",
        id: IN_B,
        name: `d ${tag}`,
        status: "active",
        organization_id: ORG_B,
      },
      {
        type: "user",
        id: ADA,
        name: `a ${tag}`,
        email: `ada-${tag}@example.test`,
        status: "active",
      },
      {
        type: "user",
        id: BOT,
        name: `e ${tag}`,
        status: "active",
        user_type: "service_account",
      },
    ]);
  });
  afterAll(async () => {
    await clearDirectory();
    await app.close();
  });

  it("lists human users, global groups and the caller's organization's, by name", async () => {
    const res = await list();
    expect(res.status).toBe(200);
    expect(res.body.truncated).toBe(false);
    expect(ours(res.body.data)).toEqual([ADA, GLOBAL, IN_A]);
  });

  it("lists a caller with no organization only the global groups", async () => {
    const res = await list(tokenFor({ permissions: [DATA_READ] }));
    expect(ours(res.body.data)).toEqual([ADA, GLOBAL]);
  });

  it("answers with Cache-Control no-store", async () => {
    const res = await fetch(`${app.url}/v1/me/principals/all`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("answers 403 without zeteo.data.read, 401 without a token, 400 to a query parameter", async () => {
    expect((await list(tokenFor({ permissions: [] }))).status).toBe(403);
    expect((await list(null)).status).toBe(401);
    expect((await list(token, "?type=user")).status).toBe(400);
  });
});
