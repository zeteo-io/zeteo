import { errorHandler } from "../../utils/errors.js";
import express, { type Router } from "express";
import type { Server } from "http";

/**
 * A `/v1` router on an app served from the test's own process, so a test can
 * change in-process state (a cache, a client) that the shared server's
 * routes would not see.
 */
export const startV1App = async (v1Router: Router) => {
  const app = express();
  app.use("/v1", v1Router);
  app.use(errorHandler);
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const url = `http://localhost:${(server.address() as { port: number }).port}`;
  return {
    url,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
};

/**
 * The real `/v1` router served from the test's own process, with the tereo
 * client it needs. Sources opened through it live in this process's pools.
 */
export const startV1Routes = async () => {
  const { initializeTereo, stopTereo } = await import("../../utils/tereo.js");
  const { default: v1Router } = await import("../../routes/v1/index.js");
  await initializeTereo();
  const app = await startV1App(v1Router);
  return {
    url: app.url,
    close: async () => {
      await app.close();
      await stopTereo();
    },
  };
};
