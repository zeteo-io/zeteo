// @module-tag int
// @module-tag platform
import { clearDirectory, seedDirectory } from "../../../support/principals.js";
import type { Principal } from "../../../../principals/directory.js";
import { grantsReadToken } from "../../../support/grants.js";
import { startV1Routes } from "../../../support/v1App.js";
import { tokenFor } from "../../../support/tokens.js";
import { fetchJson } from "../../../support/http.js";
import { redis } from "../../../../utils/redis.js";
import { randomUUID } from "crypto";
import {
  DATA_READ,
  GRANTS_READ,
  RUNS_READ,
} from "../../../../definitions/tereoDeclaration.js";
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
const GROUP = randomUUID();
const GONE = randomUUID();

const seeded: Principal[] = [
  {
    type: "user",
    id: ADA,
    name: `Ada ${tag}`,
    email: `ada-${tag}@example.test`,
    status: "active",
  },
  { type: "group", id: GROUP, name: `Analysts ${tag}`, status: "active" },
];

describe("/v1/principals", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;

  const search = (query: string, token: string | null = grantsReadToken()) =>
    fetchJson("GET", `${app.url}/v1/principals${query}`, token);
  const lookup = (body: unknown, token: string | null = grantsReadToken()) =>
    fetchJson("POST", `${app.url}/v1/principals/lookup`, token, body);

  beforeAll(async () => {
    app = await startV1Routes();
    await seedDirectory(seeded);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await clearDirectory();
    await app.close();
  });

  describe("GET /", () => {
    it("answers with Cache-Control no-store", async () => {
      const res = await fetch(`${app.url}/v1/principals?type=user&q=ada`, {
        headers: { Authorization: `Bearer ${grantsReadToken()}` },
      });
      expect(res.headers.get("cache-control")).toBe("no-store");
    });

    it("finds a seeded user by name and a group by name", async () => {
      const users = await search(`?type=user&q=ada ${tag}`);
      expect(users.status).toBe(200);
      expect(users.body).toEqual({ data: [seeded[0]] });
      const groups = await search(`?type=group&q=analysts ${tag}`);
      expect(groups.body).toEqual({ data: [seeded[1]] });
      expect(groups.body.data[0]).not.toHaveProperty("email");
    });

    it("answers 403 to a holder of only zeteo.data.read", async () => {
      const res = await search(
        `?type=user&q=ada`,
        tokenFor({ permissions: [DATA_READ] })
      );
      expect(res.status).toBe(403);
    });

    it("answers 403 to a holder of only zeteo.runs.read", async () => {
      const res = await search(
        `?type=user&q=ada`,
        tokenFor({ permissions: [RUNS_READ] })
      );
      expect(res.status).toBe(403);
    });

    it("answers 200 to a service account holding zeteo.grants.read", async () => {
      const res = await search(
        `?type=user&q=ada ${tag}`,
        tokenFor({ permissions: [GRANTS_READ], client: "svc" })
      );
      expect(res.status).toBe(200);
    });

    it("answers 401 without a token", async () => {
      expect((await search(`?type=user&q=ada`, null)).status).toBe(401);
    });

    it("answers 502 tereo_unreachable when the directory fails", async () => {
      vi.spyOn(redis, "hgetall").mockRejectedValue(new Error("redis down"));
      const res = await search(`?type=user&q=ada`);
      expect(res.status).toBe(502);
      expect(res.body.error).toBe("tereo_unreachable");
    });
  });

  describe("POST /lookup", () => {
    it("answers with Cache-Control no-store", async () => {
      const res = await fetch(`${app.url}/v1/principals/lookup`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${grantsReadToken()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ principals: [{ type: "user", id: ADA }] }),
      });
      expect(res.headers.get("cache-control")).toBe("no-store");
    });

    it("returns principals in order, an unknown one orphaned", async () => {
      const res = await lookup({
        principals: [
          { type: "group", id: GROUP },
          { type: "user", id: GONE },
          { type: "user", id: ADA },
        ],
      });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([
        seeded[1],
        { type: "user", id: GONE, name: null, email: null, status: "orphaned" },
        seeded[0],
      ]);
    });

    it("lets a holder of only zeteo.runs.read look up", async () => {
      const res = await lookup(
        { principals: [{ type: "user", id: ADA }] },
        tokenFor({ permissions: [RUNS_READ] })
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([seeded[0]]);
    });

    it("answers 403 naming both permissions to a holder of neither", async () => {
      const res = await lookup(
        { principals: [{ type: "user", id: ADA }] },
        tokenFor({ permissions: [DATA_READ] })
      );
      expect(res.status).toBe(403);
      expect(res.body.error_description).toBe(
        `Requires one of: ${GRANTS_READ}, ${RUNS_READ}`
      );
    });

    it("answers 200 to a service account holding zeteo.grants.read", async () => {
      const res = await lookup(
        { principals: [{ type: "user", id: ADA }] },
        tokenFor({ permissions: [GRANTS_READ], client: "svc" })
      );
      expect(res.status).toBe(200);
    });

    it("answers 401 without a token", async () => {
      const res = await lookup(
        { principals: [{ type: "user", id: ADA }] },
        null
      );
      expect(res.status).toBe(401);
    });

    it("answers 502 tereo_unreachable when the directory fails", async () => {
      vi.spyOn(redis, "hmget").mockRejectedValue(new Error("redis down"));
      const res = await lookup({ principals: [{ type: "user", id: ADA }] });
      expect(res.status).toBe(502);
      expect(res.body.error).toBe("tereo_unreachable");
    });
  });
});
