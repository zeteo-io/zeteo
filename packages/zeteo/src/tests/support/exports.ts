import { DATA_EXPORT, DATA_READ } from "../../definitions/tereoDeclaration.js";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { fixtureAdminSettings, FIXTURE_ROLES } from "./fixtureDb.js";
import { queryMssqlAdmin } from "./mssqlFixture.js";
import type { EngineFixture } from "./engines.js";
import { tokenFor } from "./tokens.js";
import { gunzipSync } from "node:zlib";
import { BASE_URL } from "./http.js";
import { randomUUID } from "crypto";
import { request } from "node:http";
import { Client } from "pg";

/** A user who may query and export, and their token. */
export const newExportUser = () => {
  const id = randomUUID();
  return {
    principal: { type: "user" as const, id },
    id,
    token: tokenFor({ userId: id, permissions: [DATA_READ, DATA_EXPORT] }),
  };
};

export interface ExportRequest {
  token: string;
  body: unknown;
  /** The query string after `?`, e.g. `format=csv`. */
  search?: string;
  acceptEncoding?: string;
  baseUrl?: string;
}

/**
 * `POST /v1/export` on a raw HTTP client, which hands over trailers and fails
 * a read that ends without the final chunk. Resolves with the response once
 * it has started; the body is read by the caller.
 */
export const openExport = ({
  token,
  body,
  search = "",
  acceptEncoding,
  baseUrl = BASE_URL,
}: ExportRequest): Promise<IncomingMessage> =>
  new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = request(
      `${baseUrl}/v1/export${search ? `?${search}` : ""}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          ...(acceptEncoding !== undefined && {
            "Accept-Encoding": acceptEncoding,
          }),
        },
      },
      resolve
    );
    req.on("error", reject);
    req.end(payload);
  });

export interface ExportResponse {
  status: number;
  headers: IncomingHttpHeaders;
  trailers: NodeJS.Dict<string>;
  /** The body as sent, before any decoding. */
  raw: Buffer;
  /** The body, gunzipped when it was sent gzipped. */
  text: string;
}

/** Reads the whole response; rejects when it ends without its final chunk. */
export const readExport = async (
  res: IncomingMessage
): Promise<ExportResponse> => {
  const chunks: Buffer[] = [];
  for await (const chunk of res) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks);
  const text = (
    res.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw
  ).toString("utf8");
  return {
    status: res.statusCode!,
    headers: res.headers,
    trailers: res.trailers,
    raw,
    text,
  };
};

export const postExport = async (
  request: ExportRequest
): Promise<ExportResponse> => readExport(await openExport(request));

/** The lines of an NDJSON body, parsed; the body must end with a newline. */
export const ndjsonLines = (text: string): unknown[] => {
  if (!text.endsWith("\n")) throw new Error("the body does not end a line");
  return text
    .slice(0, -1)
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);
};

/**
 * Ends the fixture sessions of the read-only login that are reading `view`,
 * as if the source's server had dropped them. Returns how many it ended.
 */
export const endSessionsReading = async (
  engine: EngineFixture,
  view: string
): Promise<number> => {
  if (engine.type === "postgres") {
    const admin = new Client({ ...fixtureAdminSettings(), ssl: false });
    await admin.connect();
    try {
      const { rows } = await admin.query<{ pid: number }>(
        `SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND usename = $1
            AND state <> 'idle' AND pid <> pg_backend_pid()
            AND query LIKE $2`,
        [FIXTURE_ROLES.ro.user, `%${view}%`]
      );
      for (const { pid } of rows) {
        await admin.query("SELECT pg_terminate_backend($1)", [pid]);
      }
      return rows.length;
    } finally {
      await admin.end();
    }
  }
  const sessions = await queryMssqlAdmin<{ session_id: number }>(
    `SELECT r.session_id FROM sys.dm_exec_requests r
      CROSS APPLY sys.dm_exec_input_buffer(r.session_id, r.request_id) b
      WHERE r.database_id = DB_ID() AND r.session_id <> @@SPID
        AND b.event_info LIKE @p0`,
    [`%${view}%`]
  );
  for (const { session_id } of sessions) {
    await queryMssqlAdmin(`KILL ${Number(session_id)}`);
  }
  return sessions.length;
};

/** Polls `check` until it returns a value other than `undefined`, for up to `ms`. */
export const eventually = async <T>(
  check: () => Promise<T | undefined>,
  ms = 5000
): Promise<T> => {
  const until = Date.now() + ms;
  for (;;) {
    const found = await check();
    if (found !== undefined) return found;
    if (Date.now() > until) throw new Error("never happened");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};
