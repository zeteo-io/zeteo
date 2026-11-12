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
