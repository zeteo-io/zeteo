// @module-tag int
// @module-tag platform
import { STAGING_SCHEMA } from "../../../../../file-sources/storage.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startV1Routes } from "../../../../support/v1App.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import { tokenFor } from "../../../../support/tokens.js";
import env from "../../../../../env.js";
import { randomUUID } from "crypto";
import {
  DATA_READ,
  FILE_SOURCES_WRITE,
} from "../../../../../definitions/tereoDeclaration.js";
import {
  removeFileSourcesOf,
  stageFile,
  uploadsCall,
} from "../../../../support/fileSources.js";

const ownerId = randomUUID();
const owner = tokenFor({
  userId: ownerId,
  permissions: [DATA_READ, FILE_SOURCES_WRITE],
});
const otherId = randomUUID();
const other = tokenFor({
  userId: otherId,
  permissions: [DATA_READ, FILE_SOURCES_WRITE],
});

const CSV = "a,b\n1,2\n";

const stagingTables = async () =>
  (
    await prisma.$queryRawUnsafe<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
      STAGING_SCHEMA
    )
  ).map((r) => r.table_name);

/** A multipart upload of `content` to `POST /v1/uploads`. */
const upload = async (token: string, content: string) => {
  const form = new FormData();
  form.append("file", new Blob([content]), "data.csv");
  const res = await fetch(`${app.url}/v1/uploads`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  return {
    status: res.status,
    body: (await res.json()) as { staging_id: string },
  };
};

let app: Awaited<ReturnType<typeof startV1Routes>>;
const call = (method: string, path: string, token: string) =>
  uploadsCall(app.url, method, path, token);

beforeAll(async () => {
  app = await startV1Routes();
});
afterAll(async () => {
  await removeFileSourcesOf([ownerId, otherId]);
  await app.close();
});

describe("DELETE /v1/uploads/:uploadId", () => {
  it("discards the caller's own staging: its tables, its row and its place under the cap", async () => {
    const max = env.FILE_SOURCE_MAX_STAGINGS;
    env.FILE_SOURCE_MAX_STAGINGS = 1;
    try {
      const first = await upload(owner, CSV);
      expect(first.status).toBe(201);
      const id = first.body.staging_id as string;
      const row = await prisma.fileStaging.findUniqueOrThrow({
        where: { id },
      });
      const tables = (row.tables as { stagingTable: string }[]).map(
        (t) => t.stagingTable
      );
      expect(await stagingTables()).toEqual(expect.arrayContaining(tables));
      expect((await upload(owner, CSV)).status).toBe(429);

      const res = await call("DELETE", `/${id}`, owner);
      expect(res.status).toBe(204);
      expect(await prisma.fileStaging.findUnique({ where: { id } })).toBeNull();
      const left = await stagingTables();
      for (const t of tables) expect(left).not.toContain(t);
      // The cap has room again.
      expect((await upload(owner, CSV)).status).toBe(201);
      // Gone: a second discard finds nothing.
      const again = await call("DELETE", `/${id}`, owner);
      expect([again.status, again.body.error]).toEqual([
        404,
        "staging_not_found",
      ]);
    } finally {
      env.FILE_SOURCE_MAX_STAGINGS = max;
    }
  });

  it("answers 404 staging_not_found for someone else's staging and an unknown id, keeping it", async () => {
    const staged = await stageFile(ownerId, CSV);
    for (const [token, id] of [
      [other, staged.stagingId],
      [owner, randomUUID()],
    ] as const) {
      const res = await call("DELETE", `/${id}`, token);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("staging_not_found");
    }
    expect(
      await prisma.fileStaging.findUnique({ where: { id: staged.stagingId } })
    ).not.toBeNull();
  });

  it("needs zeteo.file_sources.write", async () => {
    const staged = await stageFile(ownerId, CSV);
    const reader = tokenFor({ userId: ownerId, permissions: [DATA_READ] });
    expect((await call("DELETE", `/${staged.stagingId}`, reader)).status).toBe(
      403
    );
  });
});
