// @module-tag int
// @module-tag platform
// @module-tag race
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startV1Routes } from "../../../support/v1App.js";
import { prisma } from "../../../../utils/db/prisma.js";
import { tokenFor } from "../../../support/tokens.js";
import env from "../../../../env.js";
import { randomUUID } from "crypto";
import {
  DATA_READ,
  FILE_SOURCES_WRITE,
} from "../../../../definitions/tereoDeclaration.js";
import {
  createFileSource,
  csvOf,
  fileSourcesCall,
  removeFileSourcesOf,
  stageFile,
} from "../../../support/fileSources.js";

const ownerId = randomUUID();
const owner = tokenFor({
  userId: ownerId,
  permissions: [DATA_READ, FILE_SOURCES_WRITE],
});
const CSV = csvOf(
  ["id", "name"],
  Array.from({ length: 200 }, (_, i) => [String(i), `name ${i}`])
);

let app: Awaited<ReturnType<typeof startV1Routes>>;
const zfSchemas = async () =>
  (
    await prisma.$queryRaw<Array<{ n: string }>>`
      SELECT nspname AS n FROM pg_namespace
      WHERE nspname LIKE 'zf\\_%' ORDER BY nspname`
  ).map((r) => r.n);

beforeAll(async () => {
  app = await startV1Routes();
});
afterAll(async () => {
  await removeFileSourcesOf([ownerId]);
  await app.close();
});

describe("POST /v1/file-sources: quota", () => {
  it("lets one of two parallel creates that together pass the quota through", async () => {
    // The size of one such source, measured, then given back.
    const probe = await createFileSource(app.url, owner, ownerId, CSV);
    const one = probe.stored_bytes;
    expect(
      (await fileSourcesCall(app.url, "DELETE", `/${probe.id}`, owner)).status
    ).toBe(204);
    const schemasBefore = await zfSchemas();

    const quota = env.FILE_SOURCE_QUOTA_BYTES;
    env.FILE_SOURCE_QUOTA_BYTES = Math.floor(one * 1.5);
    try {
      const staged = await Promise.all([
        stageFile(ownerId, CSV),
        stageFile(ownerId, CSV),
      ]);
      const results = await Promise.all(
        staged.map((s, i) =>
          fileSourcesCall(app.url, "POST", "", owner, {
            staging_id: s.stagingId,
            name: `Race ${i}`,
            tables: [{ key: "csv" }],
          })
        )
      );
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(results.find((r) => r.status === 409)!.body.error).toBe(
        "quota_exceeded"
      );
      const created = results.find((r) => r.status === 201)!.body;
      expect(
        await prisma.source.count({
          where: { ownerId, archivedAt: null },
        })
      ).toBe(1);
      expect(await zfSchemas()).toEqual(
        [...schemasBefore, `zf_${created.id.replace(/-/g, "")}`].sort()
      );
    } finally {
      env.FILE_SOURCE_QUOTA_BYTES = quota;
    }
  });
});
