// @module-tag int
// @module-tag platform
import { sealSettings } from "../../../../../../utils/crypto/envelope.js";
import { closeSourcePool } from "../../../../../../sources/pools.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startV1Routes } from "../../../../../support/v1App.js";
import { prisma } from "../../../../../../utils/db/prisma.js";
import { fetchJson } from "../../../../../support/http.js";
import { randomUUID } from "crypto";
import {
  auditRows,
  readToken,
  removeSources,
  sourceBody,
  sourceSettings,
  writeToken,
} from "../../../../../support/sources.js";

describe("POST /v1/sources/:sourceId/refresh", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  const created: string[] = [];

  const call = (method: string, path: string, token = writeToken()) =>
    fetchJson(method, `${app.url}/v1/sources${path}`, token);

  const newSource = async () => {
    const res = await fetchJson(
      "POST",
      `${app.url}/v1/sources`,
      writeToken(),
      sourceBody(sourceSettings("ro"), { schemas: ["sales"] })
    );
    created.push(res.body.id);
    return res.body.id as string;
  };

  beforeAll(async () => {
    app = await startV1Routes();
  });
  afterAll(async () => {
    await removeSources(created);
    await app.close();
  });

  it("answers the summary and records the refresh in the audit trail", async () => {
    const id = await newSource();
    const res = await call("POST", `/${id}/refresh`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      tables: { added: 0, missing: 0, restored: 0 },
      columns: { added: 0, changed: 0, missing: 0, restored: 0 },
      relations: { added: 0, missing: 0, restored: 0 },
    });
    const entries = await auditRows(id);
    expect(entries.at(-1)?.payload).toMatchObject({
      action: "UPDATE",
      metadata: { event: "zeteo.source.refreshed", ...res.body },
    });
  });

  it("answers 403 to a read-only caller, 404 to an unknown source and 409 to an archived one", async () => {
    const id = await newSource();
    expect((await call("POST", `/${id}/refresh`, readToken())).status).toBe(
      403
    );
    expect((await call("POST", `/${randomUUID()}/refresh`)).status).toBe(404);
    await call("POST", `/${id}/archive`);
    const res = await call("POST", `/${id}/refresh`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("source_archived");
  });

  it("answers 502 source_unreachable and marks the source unreachable", async () => {
    const id = await newSource();
    await prisma.source.update({
      where: { id },
      data: {
        sealedSettings: sealSettings(
          sourceSettings("ro", { port: 1 }),
          id
        ) as object,
      },
    });
    await closeSourcePool(id);
    const res = await call("POST", `/${id}/refresh`);
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("source_unreachable");
    expect((await call("GET", `/${id}`)).body.status).toBe("unreachable");
  });
});
