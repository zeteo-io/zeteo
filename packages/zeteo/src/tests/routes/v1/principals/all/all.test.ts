// @module-tag int
// @module-tag platform
import type { Principal } from "../../../../../principals/directory.js";
import { grantsReadToken } from "../../../../support/grants.js";
import { startV1Routes } from "../../../../support/v1App.js";
import { tokenFor } from "../../../../support/tokens.js";
import { fetchJson } from "../../../../support/http.js";
import { redis } from "../../../../../utils/redis.js";
import { randomUUID } from "crypto";
import {
  DATA_READ,
  GRANTS_READ,
  RUNS_READ,
} from "../../../../../definitions/tereoDeclaration.js";
import {
  clearDirectory,
  addToDirectory,
  markOrphaned,
  clearOrphaned,
} from "../../../../support/principals.js";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const tag = randomUUID().slice(0, 8);
const ADA = randomUUID();
const BOT = randomUUID();
const NAMELESS = randomUUID();
const GLOBAL = randomUUID();
const IN_ORG = randomUUID();
const GONE = randomUUID();

describe("GET /v1/principals/all", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  const list = (token: string | null = grantsReadToken(), query = "") =>
    fetchJson("GET", `${app.url}/v1/principals/all${query}`, token);
  /** The listed principals this file seeded, in the order given. */
  const ours = (data: Principal[]) =>
    data.filter((p) =>
      new Set<string>([ADA, BOT, NAMELESS, GLOBAL, IN_ORG, GONE]).has(p.id)
    );

  beforeAll(async () => {
    app = await startV1Routes();
    await addToDirectory([
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
        name: `c ${tag}`,
        status: "active",
        user_type: "service_account",
      },
      {
        type: "user",
        id: NAMELESS,
        name: null,
        email: `x-${tag}@example.test`,
        status: "inactive",
      },
      { type: "group", id: GLOBAL, name: `B ${tag}`, status: "active" },
      {
        type: "group",
        id: IN_ORG,
        name: `d ${tag}`,
        status: "active",
        organization_id: randomUUID(),
      },
      { type: "group", id: GONE, name: `e ${tag}`, status: "active" },
    ]);
    await markOrphaned(GONE);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await clearOrphaned(GONE);
    await clearDirectory();
    await app.close();
  });

  it("lists every user, service accounts included, and every group of any organization, by name with no name last", async () => {
    const res = await list();
    expect(res.status).toBe(200);
    expect(res.body.truncated).toBe(false);
    expect(ours(res.body.data).map((p) => p.id)).toEqual([
      ADA,
      GLOBAL,
      BOT,
      IN_ORG,
      NAMELESS,
    ]);
    const group = res.body.data.find((p: Principal) => p.id === GLOBAL);
    expect(group).toEqual({
      type: "group",
      id: GLOBAL,
      name: `B ${tag}`,
      status: "active",
    });
  });

  it("answers with Cache-Control no-store", async () => {
    const res = await fetch(`${app.url}/v1/principals/all`, {
      headers: { Authorization: `Bearer ${grantsReadToken()}` },
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("answers 403 to a holder of only zeteo.data.read or zeteo.runs.read, 401 without a token", async () => {
    for (const permission of [DATA_READ, RUNS_READ]) {
      const res = await list(tokenFor({ permissions: [permission] }));
      expect(res.status).toBe(403);
    }
    expect((await list(null)).status).toBe(401);
  });

  it("answers 200 to a service account holding zeteo.grants.read", async () => {
    const res = await list(
      tokenFor({ permissions: [GRANTS_READ], client: "svc" })
    );
    expect(res.status).toBe(200);
  });

  it("answers 400 to a query parameter", async () => {
    expect((await list(grantsReadToken(), "?q=ada")).status).toBe(400);
  });

  it("answers 502 tereo_unreachable when the directory fails", async () => {
    vi.spyOn(redis, "hgetall").mockRejectedValue(new Error("redis down"));
    const res = await list();
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("tereo_unreachable");
  });
});
