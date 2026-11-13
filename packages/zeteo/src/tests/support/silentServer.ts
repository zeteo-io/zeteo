import { createServer, type Socket } from "node:net";

export interface SilentServer {
  port: number;
  close: () => Promise<void>;
}

/**
 * A loopback listener that accepts connections and never answers: a source
 * that is reachable but too slow, which a closed port (refused at once) does
 * not stand for.
 */
export const startSilentServer = async (): Promise<SilentServer> => {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as { port: number }).port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
};
