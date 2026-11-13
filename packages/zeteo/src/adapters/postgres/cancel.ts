import { logger } from "../../utils/logger.js";
import { connect } from "node:net";

const CANCEL_REQUEST_CODE = 80877102;
/** How long a cancel request may take to connect and be answered. */
export const CANCEL_TIMEOUT_MS = 1000;

export interface CancelTarget {
  /** The address the pool dials: already resolved and checked against the network rules. */
  host: string;
  port: number;
}

/**
 * Asks the server to cancel the statement a backend is running, with the
 * protocol's CancelRequest on a connection of its own, so it never waits for
 * a pool connection. The request carries no credentials: the backend's pid
 * and secret key are the authority, and the server answers by closing the
 * connection once it has signalled the backend. Resolves whether the request
 * was delivered.
 */
export const sendCancelRequest = (
  target: CancelTarget,
  processID: number,
  secretKey: number,
  timeoutMs = CANCEL_TIMEOUT_MS
): Promise<boolean> =>
  new Promise((resolve) => {
    const packet = Buffer.alloc(16);
    packet.writeInt32BE(16, 0);
    packet.writeInt32BE(CANCEL_REQUEST_CODE, 4);
    packet.writeInt32BE(processID, 8);
    packet.writeInt32BE(secretKey, 12);
    let sent = false;
    let settled = false;
    const socket = connect({ host: target.host, port: target.port });
    const done = (delivered: boolean, err?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (!delivered) logger.warn({ err }, "cancelling a source query failed");
      resolve(delivered);
    };
    const timer = setTimeout(
      () => done(false, new Error("cancel request timed out")),
      timeoutMs
    );
    socket.once("connect", () => {
      socket.write(packet, () => {
        sent = true;
      });
    });
    socket.once("error", (err) => done(false, err));
    socket.once("close", () =>
      done(sent, sent ? undefined : new Error("closed before sending"))
    );
  });
