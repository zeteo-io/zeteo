// @module-tag int
// @module-tag platform
import { removeDashboardsOf } from "../../../../../support/panelDecisions.js";
import { chartedQuery } from "../../../../../support/dashboards.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeSources } from "../../../../../support/sources.js";
import { ENGINES } from "../../../../../support/engines.js";
import {
  savedQueryOf,
  uniqueName,
  userWithOrders,
} from "../../../../../support/savedQueries.js";
import {
  savedPanelOf,
  savedPanelsCall,
} from "../../../../../support/savedPanels.js";
import {
  addUserToDirectory,
  clearDirectory,
} from "../../../../../support/principals.js";
import {
  removeRunsOf,
  seedQuerySource,
  type SeededSource,
} from "../../../../../support/queries.js";

describe("POST /v1/saved-panels/:savedPanelId/transfer", () => {
  let source: SeededSource;
  const users: string[] = [];
  const user = async () => {
    const u = await userWithOrders(source, "all");
    users.push(u.id);
    await addUserToDirectory(u.id);
    return u;
  };

  beforeAll(async () => {
    source = await seedQuerySource(ENGINES[0]!, {}, "savedpaneltransfer");
  });
  afterAll(async () => {
    await clearDirectory();
    await removeDashboardsOf(users);
    await removeRunsOf(users);
    await removeSources([source.id]);
  });

  it("hands it over; the old owner keeps it as shared by default", async () => {
    const owner = await user();
    const next = await user();
    const sq = await savedQueryOf(owner.token, source, {
      query: chartedQuery(source),
    });
    const id = await savedPanelOf(owner.token, sq);
    const res = await savedPanelsCall("POST", `/${id}/transfer`, owner.token, {
      user_id: next.id,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ id, owner: { id: next.id } });
    const shared = await savedPanelsCall("GET", "?scope=shared", owner.token);
    expect(shared.body.data.map((d: { id: string }) => d.id)).toEqual([id]);
  });

  it("refuses the current owner, and a new owner with a saved panel of that name", async () => {
    const owner = await user();
    const next = await user();
    const sq = await savedQueryOf(owner.token, source, {
      query: chartedQuery(source),
    });
    const nextSq = await savedQueryOf(next.token, source, {
      query: chartedQuery(source),
    });
    const name = uniqueName("same");
    const id = await savedPanelOf(owner.token, sq, { name });
    await savedPanelOf(next.token, nextSq, { name });
    const self = await savedPanelsCall("POST", `/${id}/transfer`, owner.token, {
      user_id: owner.id,
    });
    expect(self.status).toBe(400);
    expect(self.body.error).toBe("invalid_transfer");
    const taken = await savedPanelsCall(
      "POST",
      `/${id}/transfer`,
      owner.token,
      {
        user_id: next.id,
      }
    );
    expect(taken.status).toBe(409);
  });
});
