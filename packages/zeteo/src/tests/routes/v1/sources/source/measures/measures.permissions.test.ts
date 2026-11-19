// @module-tag int
// @module-tag platform
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeSources } from "../../../../../support/sources.js";
import { startV1Routes } from "../../../../../support/v1App.js";
import { ENGINES } from "../../../../../support/engines.js";
import { tokenFor } from "../../../../../support/tokens.js";
import { randomUUID } from "crypto";
import {
  DATA_READ,
  MEASURES_WRITE,
  UPLOADS_WRITE,
} from "../../../../../../definitions/tereoDeclaration.js";
import {
  addUserToDirectory,
  clearTestGroups,
  setTestGroups,
} from "../../../../../support/principals.js";
import {
  measureBody,
  measuresAdminToken,
  measureUser,
  setEditors,
  sourcesApi,
} from "../../../../../support/measures.js";
import {
  grantTo,
  seedQuerySource,
  type SeededSource,
} from "../../../../../support/queries.js";
import {
  createUploadSource,
  csvOf,
  removeUploadSourcesOf,
} from "../../../../../support/uploads.js";

describe("/v1/sources/:sourceId/measures: who may change them", () => {
  let app: Awaited<ReturnType<typeof startV1Routes>>;
  let source: SeededSource;
  const api = sourcesApi(() => app.url);
  const listed = measureUser();
  const unlisted = measureUser();
  const grouped = measureUser();
  const groupId = randomUUID();
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
    source = await seedQuerySource(ENGINES[0]!, {}, "measures");
    for (const who of [
      listed.principal,
      unlisted.principal,
      grouped.principal,
    ]) {
      await grantTo(who, source.tables.orders!, "all");
    }
    await setTestGroups(grouped.id, [{ id: groupId, organizationId: null }]);
    await setEditors(app.url, source.id, [
      listed.principal,
      { type: "group", id: groupId },
    ]);
  });
  afterAll(async () => {
    await clearTestGroups(grouped.id);
    await removeUploadSourcesOf(owners);
    await removeSources([source.id]);
    await app.close();
  });

  it("refuses a zeteo_user who is not listed with 403", async () => {
    const res = await api(
      "POST",
      `/${source.id}/measures`,
      unlisted.token,
      measureBody("unlisted_sum", { sum: "total" })
    );
    expect(res.status).toBe(403);
  });

  it("refuses an admin who is not listed with 403", async () => {
    const res = await api(
      "POST",
      `/${source.id}/measures`,
      measuresAdminToken(),
      measureBody("admin_sum", { sum: "total" })
    );
    expect(res.status).toBe(403);
  });

  it("lets a user listed through a group create a measure", async () => {
    const res = await api(
      "POST",
      `/${source.id}/measures`,
      grouped.token,
      measureBody("grouped_sum", { sum: "total" })
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it("refuses a listed user without zeteo.measures.write", async () => {
    const res = await api(
      "POST",
      `/${source.id}/measures`,
      tokenFor({ userId: listed.id, permissions: [DATA_READ] }),
      measureBody("no_write", { sum: "total" })
    );
    expect(res.status).toBe(403);
  });

  it("refuses a change or delete by a user who is not listed with 403", async () => {
    const created = await api(
      "POST",
      `/${source.id}/measures`,
      listed.token,
      measureBody("listed_sum", { sum: "total" })
    );
    const path = `/${source.id}/measures/${created.body.id}`;
    expect(
      (await api("PATCH", path, unlisted.token, { description: "x" })).status
    ).toBe(403);
    expect((await api("DELETE", path, unlisted.token)).status).toBe(403);
  });

  it("lets an upload source's owner create measures, and no other owner", async () => {
    const me = await owner();
    const upload = await createUploadSource(
      app.url,
      me.token,
      me.id,
      csvOf(
        ["id", "amount"],
        [
          ["1", "10"],
          ["2", "32"],
        ]
      )
    );
    const created = await api("POST", `/${upload.id}/measures`, me.token, {
      ...measureBody("amount_sum", { sum: "amount" }),
      table: "data",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    // Another owner may not.
    const other = await owner();
    const refused = await api("POST", `/${upload.id}/measures`, other.token, {
      ...measureBody("other_sum", { sum: "amount" }),
      table: "data",
    });
    expect(refused.status).toBe(403);
  });
});
