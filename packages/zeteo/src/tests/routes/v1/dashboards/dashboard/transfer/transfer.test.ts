// @module-tag int
// @module-tag platform
import { removeDashboardsOf } from "../../../../../support/panelDecisions.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeSources } from "../../../../../support/sources.js";
import { tokenFor } from "../../../../../support/tokens.js";
import { ENGINES } from "../../../../../support/engines.js";
import { randomUUID } from "crypto";
import {
  DASHBOARDS_READ,
  DASHBOARDS_WRITE,
  DATA_READ,
} from "../../../../../../definitions/tereoDeclaration.js";
import {
  uniqueName,
  userWithOrders,
} from "../../../../../support/savedQueries.js";
import {
  dashboardOf,
  dashboardsCall,
  shareDashboardDirectly,
} from "../../../../../support/dashboards.js";
import {
  addToDirectory,
  addUserToDirectory,
  clearDirectory,
} from "../../../../../support/principals.js";
import {
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../../../../../support/queries.js";

describe("POST /v1/dashboards/:dashboardId/transfer", () => {
  let source: SeededSource;
  const users: string[] = [];
  const user = async () => {
    const u = await userWithOrders(source, "all");
    users.push(u.id);
    await addUserToDirectory(u.id);
    return u;
  };
  const transfer = (id: string, token: string, body: unknown) =>
    dashboardsCall("POST", `/${id}/transfer`, token, body);
  const ids = (res: { body: { data: Array<{ id: string }> } }) =>
    res.body.data.map((d) => d.id);

  beforeAll(async () => {
    source = await seedQuerySource(ENGINES[0]!, {}, "dashtransfer");
  });
  afterAll(async () => {
    await clearDirectory();
    await removeDashboardsOf(users);
    await removeRunsOf(users);
    await removeSources([source.id]);
  });

  it("hands it to the new owner; the old one keeps it as shared by default", async () => {
    const owner = await user();
    const next = await user();
    const id = await dashboardOf(owner.token);
    const res = await transfer(id, owner.token, { user_id: next.id });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id, owner: { id: next.id } });
    expect(res.body).not.toHaveProperty("warning");
    expect(ids(await dashboardsCall("GET", "", next.token))).toEqual([id]);
    expect(ids(await dashboardsCall("GET", "", owner.token))).toEqual([]);
    expect(
      ids(await dashboardsCall("GET", "?scope=shared", owner.token))
    ).toEqual([id]);
    expect(
      (await dashboardsCall("GET", `/${id}/shares`, next.token)).body.data
    ).toEqual([expect.objectContaining({ type: "user", id: owner.id })]);
    expect(
      (await dashboardsCall("GET", `/${id}/shares`, owner.token)).status
    ).toBe(404);
  });

  it("with keep_access false, leaves the old owner nothing", async () => {
    const owner = await user();
    const next = await user();
    const id = await dashboardOf(owner.token);
    const res = await transfer(id, owner.token, {
      user_id: next.id,
      keep_access: false,
    });
    expect(res.status).toBe(200);
    expect((await dashboardsCall("GET", `/${id}`, owner.token)).status).toBe(
      404
    );
  });

  it("drops the share the new owner held", async () => {
    const owner = await user();
    const next = await user();
    const id = await dashboardOf(owner.token);
    await shareDashboardDirectly(id, next.principal, owner.id);
    await transfer(id, owner.token, { user_id: next.id, keep_access: false });
    expect(
      (await dashboardsCall("GET", `/${id}/shares`, next.token)).body.data
    ).toEqual([]);
  });

  it("is a 409 when the new owner has a dashboard of that name", async () => {
    const owner = await user();
    const next = await user();
    const name = uniqueName("clash");
    const id = await dashboardOf(owner.token, { name });
    await dashboardOf(next.token, { name: name.toUpperCase() });
    const res = await transfer(id, owner.token, { user_id: next.id });
    expect(res.status).toBe(409);
    expect(
      (await dashboardsCall("GET", `/${id}`, owner.token)).body.owner.id
    ).toBe(owner.id);
  });

  it("refuses the current owner, a service account, and a user the directory lacks", async () => {
    const owner = await user();
    const id = await dashboardOf(owner.token);
    const self = await transfer(id, owner.token, { user_id: owner.id });
    expect(self.status).toBe(400);
    expect(self.body.error).toBe("invalid_transfer");
    const service = randomUUID();
    await addToDirectory([
      {
        type: "user",
        id: service,
        name: "Nightly job",
        email: "job@example.com",
        status: "active",
        user_type: "service_account",
      },
    ]);
    const svc = await transfer(id, owner.token, { user_id: service });
    expect(svc.status).toBe(400);
    expect(svc.body.error).toBe("invalid_transfer");
    const ghost = await transfer(id, owner.token, { user_id: randomUUID() });
    expect(ghost.status).toBe(400);
    expect(ghost.body.error).toBe("invalid_transfer");
    expect(
      (await dashboardsCall("GET", `/${id}`, owner.token)).body.owner.id
    ).toBe(owner.id);
  });

  it("is a 404 to a recipient; readers get a 403; writers may transfer", async () => {
    const owner = await user();
    const recipient = await user();
    const next = await user();
    const id = await dashboardOf(owner.token);
    await shareDashboardDirectly(id, recipient.principal, owner.id);
    expect(
      (await transfer(id, recipient.token, { user_id: next.id })).status
    ).toBe(404);
    const reader = tokenFor({ permissions: [DATA_READ, DASHBOARDS_READ] });
    expect((await transfer(id, reader, { user_id: next.id })).status).toBe(403);
    const writer = tokenFor({ permissions: [DATA_READ, DASHBOARDS_WRITE] });
    const res = await transfer(id, writer, { user_id: next.id });
    expect(res.status).toBe(200);
    expect(res.body.owner.id).toBe(next.id);
  });
});
