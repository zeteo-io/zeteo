// @module-tag int
// @module-tag platform
import { postgresAdapter } from "../../adapters/postgres/index.js";
import { startV1App, startV1Routes } from "../support/v1App.js";
import { sealSettings } from "../../utils/crypto/envelope.js";
import { prisma } from "../../utils/db/prisma.js";
import { fetchJson } from "../support/http.js";
import { randomUUID } from "crypto";
import { Router } from "express";
import {
  closeAllSourcePools,
  closeSourcePool,
  isSourcePoolOpen,
  withSourceConnection,
} from "../../sources/pools.js";
import {
  removeSources,
  sourceSettings,
  uniqueSlug,
  writeToken,
} from "../support/sources.js";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const created: string[] = [];

/** A source row sealed for its own id; `sealed` replaces the sealed value. */
const newSource = async (
  settings = sourceSettings("ro"),
  sealed?: (id: string) => unknown
) => {
  const id = randomUUID();
  const row = await prisma.source.create({
    data: {
      id,
      slug: uniqueSlug("pool"),
      name: "Pool test",
      type: "postgres",
      sealedSettings: (sealed
        ? sealed(id)
        : sealSettings(settings, id)) as object,
      schemas: ["public"],
      createdBy: randomUUID(),
    },
  });
  created.push(row.id);
  return row;
};

const unreadable = () => ({
  v: 1,
  kid: "other",
  wrappedKey: "",
  iv: "",
  tag: "",
  ciphertext: "",
});

describe("withSourceConnection", () => {
  const probe = Router();
  probe.get("/use/:id", async (req, res) => {
    await withSourceConnection(String(req.params.id), (c) => c.checkLogin());
    res.json({ ok: true });
  });
  let routes: Awaited<ReturnType<typeof startV1Routes>>;
  let probeApp: Awaited<ReturnType<typeof startV1App>>;

  beforeAll(async () => {
    routes = await startV1Routes();
    probeApp = await startV1App(probe);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeAllSourcePools();
  });
  afterAll(async () => {
    await probeApp.close();
    await removeSources(created);
    await routes.close();
  });

  it("reuses one pool for two calls", async () => {
    const source = await newSource();
    const connect = vi.spyOn(postgresAdapter, "connect");
    await withSourceConnection(source.id, (c) => c.checkLogin());
    await withSourceConnection(source.id, (c) => c.checkLogin());
    expect(connect).toHaveBeenCalledTimes(1);
    expect(isSourcePoolOpen(source.id)).toBe(true);
  });

  it("opens one pool for concurrent first uses", async () => {
    const source = await newSource();
    const connect = vi.spyOn(postgresAdapter, "connect");
    await Promise.all(
      [1, 2, 3, 4].map(() =>
        withSourceConnection(source.id, (c) => c.checkLogin())
      )
    );
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("opens a new pool after closeSourcePool", async () => {
    const source = await newSource();
    const connect = vi.spyOn(postgresAdapter, "connect");
    await withSourceConnection(source.id, (c) => c.checkLogin());
    await closeSourcePool(source.id);
    expect(isSourcePoolOpen(source.id)).toBe(false);
    await withSourceConnection(source.id, (c) => c.checkLogin());
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("lets a running call finish when its pool is closed, then closes it", async () => {
    const source = await newSource();
    let closing: Promise<void> | undefined;
    const findings = await withSourceConnection(source.id, async (conn) => {
      closing = closeSourcePool(source.id);
      return conn.checkLogin();
    });
    await closing;
    expect(findings).toEqual([]);
    expect(isSourcePoolOpen(source.id)).toBe(false);
  });

  it("closes a pool idle for five minutes", async () => {
    const source = await newSource();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await withSourceConnection(source.id, (c) => c.checkLogin());
      expect(isSourcePoolOpen(source.id)).toBe(true);
      await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
      expect(isSourcePoolOpen(source.id)).toBe(true);
      await vi.advanceTimersByTimeAsync(2);
    } finally {
      vi.useRealTimers();
    }
    expect(isSourcePoolOpen(source.id)).toBe(false);
  });

  it("re-runs the network check when it opens a pool", async () => {
    const source = await newSource(
      sourceSettings("ro", { host: "192.0.2.10" })
    );
    await expect(
      withSourceConnection(source.id, (c) => c.checkLogin())
    ).rejects.toMatchObject({ code: "host_not_allowed" });
    expect(isSourcePoolOpen(source.id)).toBe(false);
  });

  it("fails as a generic internal error when the settings cannot be opened", async () => {
    const source = await newSource(undefined, unreadable);
    await expect(
      withSourceConnection(source.id, (c) => c.checkLogin())
    ).rejects.toBeInstanceOf(Error);
    const res = await fetchJson(
      "GET",
      `${probeApp.url}/v1/use/${source.id}`,
      null
    );
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: "server_error",
      error_description: "An unexpected error occurred",
    });
  });

  it("still lists and views such a source, with settings null", async () => {
    const source = await newSource(undefined, unreadable);
    const one = await fetchJson(
      "GET",
      `${routes.url}/v1/sources/${source.id}`,
      writeToken()
    );
    expect(one.status).toBe(200);
    expect(one.body.settings).toBeNull();
    const list = await fetchJson(
      "GET",
      `${routes.url}/v1/sources?limit=100`,
      writeToken()
    );
    const listed = list.body.data.find(
      (s: { id: string }) => s.id === source.id
    );
    expect(listed.settings).toBeNull();
  });
});
