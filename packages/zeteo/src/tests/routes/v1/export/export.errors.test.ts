// @module-tag int
// @module-tag platform
// @module-tag slow
import { describeEachEngine } from "../../../support/engines.js";
import { removeSources } from "../../../support/sources.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { constants, gunzipSync } from "node:zlib";
import type { IncomingMessage } from "node:http";
import {
  endSessionsReading,
  eventually,
  newExportUser,
  openExport,
} from "../../../support/exports.js";
import {
  grantTo,
  removeRunsOf,
  runsOf,
  seedQuerySource,
  type SeededSource,
} from "../../../support/queries.js";

/** Resolves with the first chunk of `res`, leaving it paused. */
const firstChunk = (res: IncomingMessage) =>
  new Promise<Buffer>((resolve, reject) => {
    res.once("error", reject);
    res.once("data", (chunk: Buffer) => {
      res.pause();
      resolve(chunk);
    });
  });

/** Reads `res` (after `first`, when given) until it ends or fails, keeping what came. */
const readUntilCut = (res: IncomingMessage, first: Buffer | null) =>
  new Promise<{ raw: Buffer; err: unknown }>((resolve) => {
    const chunks: Buffer[] = first ? [first] : [];
    const done = (err?: unknown) =>
      resolve({ raw: Buffer.concat(chunks), err });
    res.on("data", (chunk: Buffer) => chunks.push(chunk));
    res.once("error", done);
    res.once("end", () => done());
    res.resume();
  });

describeEachEngine("POST /v1/export", (engine) => {
  let source: SeededSource;
  const users: string[] = [];

  /** A user granted the trickle view, whose rows come 200 ms apart after the first. */
  const exportUser = async () => {
    const user = newExportUser();
    users.push(user.id);
    await grantTo(user.principal, source.tables.trickle!, "all");
    return user;
  };

  const trickle = () => ({
    source: source.slug,
    from: "trickle",
    select: ["id", "filler"],
    // Ordered by every column by default, the rows would all be made before
    // the sort; ordered by `id`, each is made as it is read.
    orderBy: [{ id: "asc" }],
  });

  /** Resolves once the source is running the trickle's statement. */
  const statementRunning = () =>
    eventually(async () =>
      (await engine.runningOn("trickle")) > 0 ? true : undefined
    );

  const endedRun = (userId: string) =>
    eventually(async () => {
      const [run] = await runsOf([userId]);
      return run && run.outcome !== "running" ? run : undefined;
    }, 10_000);

  beforeAll(async () => {
    source = await seedQuerySource(
      engine,
      {
        export_enabled: true,
        export_row_cap: 1_000_000,
        schemas: ["sales", "probe"],
      },
      "export"
    );
  });
  afterAll(async () => {
    await removeRunsOf(users);
    await removeSources([source.id]);
  });

  it("records a client that closes its socket mid-stream as client_closed, and stops the statement", async () => {
    const user = await exportUser();
    const res = await openExport({ token: user.token, body: trickle() });
    expect(res.statusCode).toBe(200);
    await firstChunk(res);
    await statementRunning();
    res.on("error", () => undefined);
    res.socket.destroy();

    const run = await endedRun(user.id);
    expect(run).toMatchObject({
      entryPoint: "export",
      outcome: "failed",
      errorCode: "client_closed",
    });
    expect(
      await eventually(async () =>
        (await engine.runningOn("trickle")) === 0 ? true : undefined
      )
    ).toBe(true);
  });

  it.each([
    ["csv", "without gzip", undefined],
    ["csv", "with gzip", "gzip"],
    ["ndjson", "without gzip", undefined],
    ["ndjson", "with gzip", "gzip"],
  ])(
    "fails the client's read, with no final chunk, tail line or trailers, when the source drops the connection mid-stream (%s, %s)",
    async (format, _, acceptEncoding) => {
      const user = await exportUser();
      const res = await openExport({
        token: user.token,
        body: trickle(),
        search: `format=${format}`,
        acceptEncoding,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-encoding"]).toBe(acceptEncoding);
      // Unflushed, a gzip stream has sent nothing yet but its headers.
      const first = acceptEncoding === undefined ? await firstChunk(res) : null;
      await statementRunning();
      expect(await endSessionsReading(engine, "trickle")).toBeGreaterThan(0);
      const { raw, err } = await readUntilCut(res, first);
      expect(err).toBeInstanceOf(Error);
      expect(res.trailers).toEqual({});
      // What arrived before the cut, decoded as far as it goes.
      const text = (
        acceptEncoding === "gzip"
          ? gunzipSync(raw, { finishFlush: constants.Z_SYNC_FLUSH })
          : raw
      ).toString("utf8");
      if (format === "ndjson" && acceptEncoding === undefined) {
        expect(text).toContain('"columns"');
      }
      expect(text).not.toContain('"status"');
      expect(text).not.toContain("complete");

      const run = await endedRun(user.id);
      expect(run.outcome).toBe("failed");
      expect(run.errorCode).not.toBe("client_closed");
    }
  );
});
