// @module-tag int
// @module-tag platform
import { NAME_LOOKUP_DEADLINE_MS } from "../../../../routes/v1/me/controllers.js";
import { clearDirectory, seedDirectory } from "../../../support/principals.js";
import type { Principal } from "../../../../principals/directory.js";
import { startV1Routes } from "../../../support/v1App.js";
import { tokenFor } from "../../../support/tokens.js";
import { fetchJson } from "../../../support/http.js";
import { redis } from "../../../../utils/redis.js";
import { randomUUID } from "crypto";
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
const GONE = randomUUID();

const seeded: Principal[] = [
  {
    type: "user",
    id: ADA,
    name: `Ada ${tag}`,
    email: `ada-${tag}@example.test`,
    status: "active",
  },
  { type: "user", id: GONE, name: null, email: null, status: "orphaned" },
];

describe("GET /v1/me", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;

  const me = (token: string | null) =>
    fetchJson("GET", `${app.url}/v1/me`, token);

  beforeAll(async () => {
    app = await startV1Routes();
    await seedDirectory(seeded);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await clearDirectory();
    await app.close();
  });

  it("returns the caller's name, email and sorted zeteo permissions only", async () => {
    const res = await me(
      tokenFor({
        userId: ADA,
        permissions: ["zeteo.grants.write", "files.read", "zeteo.data.read"],
      })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: ADA,
      type: "user",
      name: `Ada ${tag}`,
      email: `ada-${tag}@example.test`,
      permissions: ["zeteo.data.read", "zeteo.grants.write"],
    });
  });

  it("does not expand a permission along its ladder", async () => {
    const res = await me(
      tokenFor({ userId: ADA, permissions: ["zeteo.sources.admin"] })
    );
    expect(res.body.permissions).toEqual(["zeteo.sources.admin"]);
  });

  it("includes a bare admin permission, which covers every zeteo one", async () => {
    const res = await me(
      tokenFor({ userId: ADA, permissions: ["admin", "zeteo.data.read"] })
    );
    expect(res.body.permissions).toEqual(["admin", "zeteo.data.read"]);
  });

  it("answers type service for a service account", async () => {
    const id = randomUUID();
    const res = await me(`test-token-${id}|client=${id}|perms=zeteo.data.read`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id,
      type: "service",
      permissions: ["zeteo.data.read"],
    });
  });

  it("answers 200 with no permissions for a caller with none of zeteo's", async () => {
    const res = await me(
      tokenFor({ userId: ADA, permissions: ["files.read"] })
    );
    expect(res.status).toBe(200);
    expect(res.body.permissions).toEqual([]);
  });

  it("answers null name and email for an orphaned user", async () => {
    const res = await me(tokenFor({ userId: GONE, permissions: [] }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: GONE, name: null, email: null });
  });

  it("still answers 200 with null name and email when the directory fails", async () => {
    vi.spyOn(redis, "hmget").mockRejectedValue(new Error("redis down"));
    const res = await me(
      tokenFor({ userId: ADA, permissions: ["zeteo.data.read"] })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: ADA,
      type: "user",
      name: null,
      email: null,
      permissions: ["zeteo.data.read"],
    });
  });

  it("answers with Cache-Control no-store", async () => {
    const res = await fetch(`${app.url}/v1/me`, {
      headers: {
        Authorization: `Bearer ${tokenFor({ userId: ADA, permissions: [] })}`,
      },
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("answers 200 with null name and email when the directory is slow, and survives its late rejection", async () => {
    let rejectLate: (e: Error) => void = () => {};
    const spy = vi.spyOn(redis, "hmget").mockReturnValue(
      new Promise((_, reject) => {
        rejectLate = reject;
      }) as never
    );
    const pending = me(
      tokenFor({ userId: ADA, permissions: ["zeteo.data.read"] })
    );
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await vi.advanceTimersByTimeAsync(NAME_LOOKUP_DEADLINE_MS);
    } finally {
      vi.useRealTimers();
    }
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: null, email: null });
    rejectLate(new Error("late failure"));
    await new Promise((r) => setTimeout(r, 20));
  });

  it("answers 401 without a token", async () => {
    expect((await me(null)).status).toBe(401);
  });
});
