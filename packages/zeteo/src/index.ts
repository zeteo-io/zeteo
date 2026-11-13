import "./preload.js";
import { closeHttpServer, tuneServerKeepAlive } from "./utils/httpServer.js";
import { closeRedisConnection, initializeRedis } from "./utils/redis.js";
import { getTereo, initializeTereo, stopTereo } from "./utils/tereo.js";
import { startRunsHousekeepingJob } from "./jobs/runsHousekeeping.js";
import { startRefreshJob } from "./jobs/refreshSources.js";
import { disconnectDatabase } from "./utils/db/prisma.js";
import { stopSourcePools } from "./sources/pools.js";
import { abortExports } from "./engine/export.js";
import { createServer, type Server } from "http";
import { logger } from "./utils/logger.js";
import env from "./env.js";

// In-flight HTTP requests get this long before they are cut off. The rest of
// the shutdown (Redis, the database) takes a moment more, so the default 25s
// fits the 30s that follow SIGTERM in a Kubernetes pod.
const DRAIN_TIMEOUT_MS = env.SHUTDOWN_TIMEOUT_SECONDS * 1000;
// Source calls still running once HTTP has drained belong to requests already
// cut off, so they get only a moment more within what is left of the grace.
const SOURCE_POOL_DRAIN_MS = 2_000;

/** Runs one named shutdown step, logging and keeping its failure rather than throwing it. */
export type ShutdownStep = (
  name: string,
  run: () => Promise<void>
) => Promise<void>;

/**
 * The first steps of a shutdown, in this order: every running export is
 * stopped at once, recorded as shutting down and its connection cut; then
 * HTTP drains within `drainMs`. An export may stream for ten minutes, which
 * no drain fits, so stopping exports first is what lets the drain end in
 * time. Draining before anything is torn down keeps handlers from failing
 * with "pool ended" or "client closed" mid-flight.
 */
export const drainRequests = async (
  step: ShutdownStep,
  server: Server | null,
  drainMs: number
): Promise<void> => {
  await step("exports", async () => abortExports());
  if (server) {
    await step("http", async () => {
      await closeHttpServer(server, drainMs);
      logger.info("HTTP server closed");
    });
  }
};

export interface ServerInstance {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  isRunning: () => boolean;
}

export interface AppServerOptions {
  /** Runs the scheduled catalogue refresh and the runs housekeeping; off for the test suite's shared server, whose sweeps would touch other tests' sources. */
  refreshJob?: boolean;
  /** Where MCP fetches tereo's authorization-server metadata, instead of TEREO_URL (tests). */
  mcpCoreUrl?: string;
}

export function createAppServer(
  port: number = env.PORT,
  { refreshJob = true, mcpCoreUrl }: AppServerOptions = {}
): ServerInstance {
  let server: Server | null = null;
  let running = false;
  let stopping: Promise<void> | null = null;
  let stopRefreshJob: (() => Promise<void>) | null = null;
  let stopHousekeepingJob: (() => Promise<void>) | null = null;

  return {
    start: async () => {
      if (running) throw new Error("Server is already running");
      running = true;
      await initializeRedis();
      await initializeTereo();
      // The request handler and the outbox reaper run in this process.
      await getTereo().start();

      // Imported after Redis is up, as the modules behind it may resolve the
      // client when they load.
      const { createMcpRouter } = await import("./mcp/index.js");
      const { createApp } = await import("./app.js");
      const mcpRouter = await createMcpRouter({ coreUrl: mcpCoreUrl });
      server = createServer(createApp(mcpRouter));
      tuneServerKeepAlive(server);

      const listening = server;
      await new Promise<void>((resolve, reject) => {
        listening.once("error", reject);
        listening.listen(port, () => {
          listening.off("error", reject);
          logger.info({ port }, "zeteo listening");
          resolve();
        });
      });
      if (refreshJob) {
        stopRefreshJob = startRefreshJob();
        stopHousekeepingJob = startRunsHousekeepingJob();
      }
    },

    stop: () => {
      if (!running) return Promise.resolve();
      // A second signal mid-shutdown waits on the first instead of closing
      // everything twice.
      stopping ??= (async () => {
        // Every step runs even if an earlier one fails, so a failed start
        // or a broken step still releases Redis and the database.
        const failures: unknown[] = [];
        const step: ShutdownStep = async (name, run) => {
          try {
            await run();
          } catch (err) {
            failures.push(err);
            logger.error({ err, step: name }, "Shutdown step failed");
          }
        };

        const closing = server;
        server = null;
        await drainRequests(step, closing, DRAIN_TIMEOUT_MS);
        await step("refresh job", async () => {
          await stopRefreshJob?.();
          stopRefreshJob = null;
        });
        await step("runs housekeeping job", async () => {
          await stopHousekeepingJob?.();
          stopHousekeepingJob = null;
        });
        await step("source pools", () => stopSourcePools(SOURCE_POOL_DRAIN_MS));
        await step("tereo", stopTereo);
        await step("redis", closeRedisConnection);
        await step("database", disconnectDatabase);
        running = false;
        logger.info("Server closed");
        if (failures.length > 0) {
          throw new AggregateError(failures, "Shutdown did not complete");
        }
      })().finally(() => {
        stopping = null;
      });
      return stopping;
    },

    isRunning: () => running,
  };
}

// Started directly (`node dist/index.js`), not imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  const appServer = createAppServer();

  appServer.start().catch((err) => {
    logger.error({ err }, "Failed to start server");
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      logger.info("Shutdown already in progress");
      return;
    }
    shuttingDown = true;
    logger.info("Shutting down server...");
    try {
      await appServer.stop();
    } catch {
      process.exit(1);
    }
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  process.on("uncaughtException", (err) => {
    logger.error({ err }, "uncaughtException");
    // In production, let the orchestrator restart us: a process kept alive
    // after an uncaught exception often carries subtly corrupted state.
    if (env.NODE_ENV === "production") process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    logger.error({ err: reason }, "unhandledRejection");
    if (env.NODE_ENV === "production") process.exit(1);
  });
}
