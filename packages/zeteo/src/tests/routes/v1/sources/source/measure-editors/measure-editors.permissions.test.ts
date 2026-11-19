// @module-tag int
// @module-tag platform
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerSource } from "../../../../../support/grants.js";
import { removeSources } from "../../../../../support/sources.js";
import { startV1Routes } from "../../../../../support/v1App.js";
import { tokenFor } from "../../../../../support/tokens.js";
import { randomUUID } from "crypto";
import {
  DATA_READ,
  MEASURES_WRITE,
  SOURCES_READ,
  UPLOADS_WRITE,
} from "../../../../../../definitions/tereoDeclaration.js";
import {
  addToDirectory,
  addUserToDirectory,
  clearDirectory,
} from "../../../../../support/principals.js";
import {
  measuresAdminToken,
  measureUser,
  setEditors,
  sourcesApi,
} from "../../../../../support/measures.js";
import {
  createUploadSource,
  csvOf,
  removeUploadSourcesOf,
} from "../../../../../support/uploads.js";

describe("/v1/sources/:sourceId/measure-editors: who may read and replace them", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  let sourceId: string;
  const api = sourcesApi(() => app.url);
  const editor = measureUser();
  const stranger = measureUser();
  const owners: string[] = [];

  const owner = async () => {
    const id = randomUUID();
    owners.push(id);
    await addUserToDirectory(id);
    return {
      id,
      token: tokenFor({
        userId: id,
        permissions: [UPLOADS_WRITE, DATA_READ, MEASURES_WRITE],
      }),
    };
  };

  beforeAll(async () => {
    app = await startV1Routes();
    sourceId = await registerSource(app.url);
    await setEditors(app.url, sourceId, [editor.principal]);
  });
  afterAll(async () => {
    await clearDirectory();
    await removeUploadSourcesOf(owners);
    await removeSources([sourceId]);
    await app.close();
  });

  it("lets an admin with zeteo.sources.write replace a database source's editors", async () => {
    const res = await api(
      "PUT",
      `/${sourceId}/measure-editors`,
      measuresAdminToken(),
      { principals: [editor.principal] }
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("lets an editor read the list but not replace it", async () => {
    const got = await api("GET", `/${sourceId}/measure-editors`, editor.token);
    expect(got.status).toBe(200);
    expect(got.body.data.map((e: { id: string }) => e.id)).toEqual([editor.id]);
    const put = await api("PUT", `/${sourceId}/measure-editors`, editor.token, {
      principals: [],
    });
    expect(put.status).toBe(403);
  });

  it("refuses the list to someone neither managing nor on it", async () => {
    const res = await api(
      "GET",
      `/${sourceId}/measure-editors`,
      stranger.token
    );
    expect(res.status).toBe(403);
  });

  it("refuses an admin who only reads sources", async () => {
    const res = await api(
      "PUT",
      `/${sourceId}/measure-editors`,
      tokenFor({ permissions: [SOURCES_READ] }),
      { principals: [] }
    );
    expect(res.status).toBe(403);
  });

  it("lets an upload source's owner manage its editors, and no other owner", async () => {
    const me = await owner();
    const upload = await createUploadSource(
      app.url,
      me.token,
      me.id,
      csvOf(["id"], [["1"]])
    );
    const someone = randomUUID();
    await addUserToDirectory(someone);
    const put = await api("PUT", `/${upload.id}/measure-editors`, me.token, {
      principals: [{ type: "user", id: someone }],
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.data).toEqual([
      expect.objectContaining({ type: "user", id: someone }),
    ]);
    const got = await api("GET", `/${upload.id}/measure-editors`, me.token);
    expect(got.status).toBe(200);

    const other = await owner();
    for (const method of ["GET", "PUT"]) {
      const res = await api(
        method,
        `/${upload.id}/measure-editors`,
        other.token,
        method === "PUT" ? { principals: [] } : undefined
      );
      expect(res.status, method).toBe(403);
    }
  });

  it("refuses an owner a group of another organization, as for grants", async () => {
    const me = await owner();
    const upload = await createUploadSource(
      app.url,
      me.token,
      me.id,
      csvOf(["id"], [["1"]])
    );
    const foreign = randomUUID();
    await addToDirectory([
      {
        type: "group",
        id: foreign,
        name: "Elsewhere",
        status: "active",
        organization_id: randomUUID(),
      },
    ]);
    const res = await api("PUT", `/${upload.id}/measure-editors`, me.token, {
      principals: [{ type: "group", id: foreign }],
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("group_not_allowed");
  });
});
