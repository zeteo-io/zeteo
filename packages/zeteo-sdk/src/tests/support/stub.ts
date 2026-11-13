import RequestHandler, { memoryBackend } from "@dianemo/core";
import { type AddressInfo } from "node:net";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

export type Recorded = {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
};

export type StubResponse = {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  chunks?: (string | Buffer)[];
  cutAfterChunks?: boolean;
};

export type Stub = {
  url: string;
  requests: Recorded[];
  tokensIssued: number;
  respond(fn: (req: Recorded) => StubResponse | undefined): void;
  close(): Promise<void>;
};

const tick = () => new Promise((ok) => setTimeout(ok, 5));

async function readBody(req: IncomingMessage): Promise<unknown> {
  const parts: Buffer[] = [];
  for await (const part of req) parts.push(part as Buffer);
  const text = Buffer.concat(parts).toString();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function send(res: ServerResponse, out: StubResponse): Promise<void> {
  const status = out.status ?? 200;
  if (out.chunks) {
    res.writeHead(status, {
      "content-type": "application/x-ndjson",
      ...out.headers,
    });
    for (const chunk of out.chunks) {
      if (res.destroyed) return;
      res.write(chunk);
      await tick();
    }
    if (out.cutAfterChunks) res.destroy();
    else res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json", ...out.headers });
  res.end(JSON.stringify(out.body ?? {}));
}

export async function startStub(): Promise<Stub> {
  const responders: ((req: Recorded) => StubResponse | undefined)[] = [];
  const stub: Stub = {
    url: "",
    requests: [],
    tokensIssued: 0,
    respond: (fn) => void responders.unshift(fn),
    close: () =>
      new Promise((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://stub");
      const body = await readBody(req);
      if (req.method === "POST" && url.pathname === "/oauth/token") {
        stub.tokensIssued += 1;
        await send(res, {
          body: {
            access_token: `svc-${stub.tokensIssued}`,
            token_type: "Bearer",
            expires_in: 3600,
          },
        });
        return;
      }
      const recorded: Recorded = {
        method: req.method ?? "GET",
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [
            k,
            Array.isArray(v) ? v.join(", ") : (v ?? ""),
          ])
        ),
        body,
      };
      stub.requests.push(recorded);
      let out: StubResponse | undefined;
      for (const fn of responders) {
        out = fn(recorded);
        if (out) break;
      }
      await send(res, out ?? {});
    })();
  });

  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  stub.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return stub;
}

export function testHandler(): RequestHandler {
  return new RequestHandler({ key: "k".repeat(32), backend: memoryBackend() });
}
