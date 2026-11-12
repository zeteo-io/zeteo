import type { Server } from "node:http";

/** How long a client has to send a whole request. */
export const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Keep the server's idle keep-alive window LONGER than its in-cluster
 * clients'. Node defaults both sides to 5s, so a client can reuse a socket in
 * the same instant the server tears it down, surfacing as a transient
 * ECONNRESET / "socket hang up" under bursts. With the server at 65s the
 * client always closes first and never reuses a dead socket.
 */
export function tuneServerKeepAlive(server: Server): void {
  server.keepAliveTimeout = 65_000;
  // Must exceed keepAliveTimeout: headersTimeout also clocks the idle gap
  // between keep-alive requests up to the first header byte, so a value
  // below keepAliveTimeout would reintroduce the same close-vs-reuse race.
  server.headersTimeout = 66_000;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
}

/**
 * Stop accepting connections and wait for in-flight requests, forcing the
 * rest closed after `drainMs`.
 */
export async function closeHttpServer(
  server: Server,
  drainMs: number
): Promise<void> {
  // Never listened (a failed listen): close() would reject with
  // ERR_SERVER_NOT_RUNNING, and there is nothing to drain.
  if (!server.listening) return;
  const closed = new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  const drainTimer = setTimeout(() => {
    server.closeIdleConnections();
    server.closeAllConnections();
  }, drainMs);
  try {
    await closed;
  } finally {
    clearTimeout(drainTimer);
  }
}
